import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { CdpClient } from "./cdp.js";
import { connectWebSocket } from "./ws.js";

const BLOCKED_ARG = /^(--user-data-dir|--remote-debugging-port|--remote-debugging-pipe|--remote-debugging-address|--remote-allow-origins)(=.*)?$/;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function productVersion(product) {
  const match = /(\d+\.\d+\.\d+\.\d+)/.exec(product || "");
  return match ? match[1] : String(product || "");
}

function exceptionText(details) {
  if (!details) return "評価に失敗しました";
  return details.exception?.description || details.text || "評価に失敗しました";
}

function videosInDocument() {
  const videos = [];
  const walk = (node) => {
    if (!node?.querySelectorAll) return;
    for (const video of node.querySelectorAll("video")) videos.push(video);
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot) walk(element.shadowRoot);
    }
  };
  walk(document);
  return videos;
}

function createEmitter() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const set = handlers.get(event) || new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    emit(event, arg) {
      for (const handler of handlers.get(event) || []) handler(arg);
    },
  };
}

export function formatUserDataDir(directory, platform = process.platform) {
  if (platform === "win32") return String(directory).replaceAll("\\", "/");
  return directory;
}

export function chromeLaunchArgs({ userDataDir, profileArgs = [], headless = false, sandbox = false, platform = process.platform }) {
  // `--user-data-dir` を値なしで置くと、この Chrome はスイッチを無視して
  // 既定プロファイルへ落ちる。Windows では `\` を `/` にして、コマンドラインの
  // エスケープでパスが割れないようにする。URL は about:blank だけにする。
  const args = [
    `--user-data-dir=${formatUserDataDir(userDataDir, platform)}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--window-size=1920,1080",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (platform === "linux") {
    args.push("--password-store=basic", "--disable-dev-shm-usage");
  }
  for (const arg of profileArgs) {
    if (!BLOCKED_ARG.test(arg) && !args.includes(arg)) args.push(arg);
  }
  if (headless) args.push("--headless=new");
  if (sandbox) args.push("--no-sandbox", "--disable-setuid-sandbox");
  args.push("about:blank");
  return args;
}

export function chromeProcessOptions(platform = process.platform) {
  // Windows で detached にすると、起動引数が落ちて普段の Chrome にタブだけ開く。
  return {
    detached: platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function handedToExistingChrome(log) {
  return /existing browser session|ouverture dans une session|requires a non-default data directory/i.test(String(log || ""));
}

function chromeExitError(log) {
  const detail = String(log || "").trim();
  if (handedToExistingChrome(detail)) {
    return new Error(`普段の Chrome にタブが渡されて、撮影用のプロセスは起動しませんでした。${detail ? `\n${detail}` : ""}`);
  }
  return new Error(`Chromeがすぐに終了しました${detail ? `\n${detail}` : ""}`);
}

function waitForExit(child, ms) {
  if (!child || child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return;
  const pid = child.pid;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // すでに終了している
      }
    }
  }
  await waitForExit(child, 4000);
  if (child.exitCode == null && !child.signalCode) {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // すでに終了している
        }
      }
    }
    await waitForExit(child, 2000);
  }
}

async function waitForDevtools(userDataDir, child, getLog, timeoutMs) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null || child.signalCode) {
      throw chromeExitError(getLog());
    }
    if (handedToExistingChrome(getLog())) throw chromeExitError(getLog());
    try {
      const text = await fs.readFile(file, "utf8");
      const [portLine] = text.trim().split(/\r?\n/);
      const port = Number(portLine);
      if (!port) throw new Error("ポートがまだありません");
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!response.ok) throw new Error(`DevToolsの応答が ${response.status} でした`);
      const version = await response.json();
      if (!version.webSocketDebuggerUrl) throw new Error("DevToolsのURLがありません");
      return version;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Chromeのデバッグポートが開きませんでした\n${getLog() || lastError?.message || ""}`);
}

class VideoLocator {
  constructor(frame, index) {
    this.frame = frame;
    this.index = index;
  }

  evaluate(fn, arg) {
    const argSource = arg === undefined ? "undefined" : JSON.stringify(arg);
    const expression = `(() => {
      ${videosInDocument.toString()}
      const video = videosInDocument()[${this.index}];
      if (!video) throw new Error("video がありません");
      return (${fn.toString()})(video, ${argSource});
    })()`;
    return this.frame.app.evaluateInFrame(this.frame.id, expression);
  }

  async boundingBox() {
    const local = await this.evaluate((video) => {
      const rect = video.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const offset = await this.frame.viewportOffset();
    return {
      x: local.x + offset.x,
      y: local.y + offset.y,
      width: local.width,
      height: local.height,
    };
  }

  async screenshot(options = {}) {
    await this.frame.app.evaluateInFrame(this.frame.id, `(() => {
      if (document.querySelector("[data-tf-still='1']")) return;
      const style = document.createElement("style");
      style.setAttribute("data-tf-still", "1");
      style.textContent = "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}";
      document.documentElement.append(style);
    })()`);
    try {
      const box = await this.boundingBox();
      if (!box || box.width < 1 || box.height < 1) {
        throw new Error("video の領域を読めません");
      }
      return await this.frame.page.captureClip({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        quality: options.quality ?? 90,
        timeout: options.timeout ?? 15000,
      });
    } finally {
      await this.frame.app.evaluateInFrame(this.frame.id, `(() => {
        document.querySelector("[data-tf-still='1']")?.remove();
      })()`).catch(() => {});
    }
  }
}

class FrameRef {
  constructor(app, page, id, parent) {
    this.app = app;
    this.page = page;
    this.id = id;
    this.parent = parent;
  }

  parentFrame() {
    return this.parent;
  }

  locator(selector) {
    if (selector !== "video") throw new Error(`未対応のセレクタです: ${selector}`);
    const frame = this;
    return {
      async count() {
        const expression = `(() => { ${videosInDocument.toString()}; return videosInDocument().length; })()`;
        return frame.app.evaluateInFrame(frame.id, expression);
      },
      nth(index) {
        return new VideoLocator(frame, index);
      },
    };
  }

  async frameElement() {
    if (!this.parent) return null;
    const frame = this;
    return {
      evaluate(fn, arg) {
        return frame.app.evaluateOnFrameElement(frame.id, frame.parent.id, fn, arg);
      },
    };
  }

  async viewportOffset() {
    if (!this.parent) return { x: 0, y: 0 };
    const rect = await this.app.iframeRect(this.id, this.parent.id);
    const parentOffset = await this.parent.viewportOffset();
    return { x: rect.x + parentOffset.x, y: rect.y + parentOffset.y };
  }
}

class ChromePage {
  constructor(app, sessionId, targetId) {
    this.app = app;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.closed = false;
    this.currentUrl = "";
    this.mainFrameId = null;
    this.mainFrameToken = { id: "main" };
    this.events = createEmitter();
    this.offScreencast = null;
  }

  on(event, handler) {
    this.events.on(event, handler);
  }

  emit(event, arg) {
    this.events.emit(event, arg);
  }

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed || this.app.disconnected;
  }

  mainFrame() {
    return this.mainFrameToken;
  }

  context() {
    return this.app;
  }

  async evaluate(fn, arg) {
    const expression = arguments.length < 2
      ? `(${fn.toString()})()`
      : `(${fn.toString()})(${JSON.stringify(arg)})`;
    return this.app.evaluateInFrame(this.mainFrameId, expression);
  }

  async frames() {
    await this.app.refreshTrees();
    if (this.mainFrameId) {
      const tree = await this.app.cdp.send("Page.getFrameTree", {}, this.sessionId).catch(() => null);
      if (tree?.frameTree?.frame?.id) this.mainFrameId = tree.frameTree.frame.id;
    }
    const nodes = [];
    const seen = new Set();
    const walk = (id, parent) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      const frame = new FrameRef(this.app, this, id, parent);
      nodes.push(frame);
      for (const [childId, parentId] of this.app.frameParents) {
        if (parentId === id) walk(childId, frame);
      }
    };
    walk(this.mainFrameId, null);
    return nodes;
  }

  async captureClip({ x, y, width, height, quality = 90, timeout = 15000 }) {
    const result = await this.app.cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality,
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: Math.max(0, x),
        y: Math.max(0, y),
        width,
        height,
        scale: 1,
      },
    }, this.sessionId, timeout);
    return Buffer.from(result.data, "base64");
  }

  async refreshMainFrame() {
    const tree = await this.app.cdp.send("Page.getFrameTree", {}, this.sessionId);
    this.mainFrameId = tree.frameTree.frame.id;
    this.currentUrl = tree.frameTree.frame.url || this.currentUrl;
    this.app.noteTree(this.sessionId, tree.frameTree);
  }

  waitForLoad(timeout) {
    if (this.isClosed()) throw new Error("ページは閉じられています");
    let timer;
    let off = () => {};
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        off();
        reject(new Error("ページの読み込みがタイムアウトしました"));
      }, timeout);
      off = this.app.cdp.on("Page.lifecycleEvent", (params, sessionId) => {
        if (sessionId !== this.sessionId) return;
        if (params.name !== "DOMContentLoaded") return;
        if (this.mainFrameId && params.frameId && params.frameId !== this.mainFrameId) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    return {
      promise,
      cancel() {
        clearTimeout(timer);
        off();
      },
    };
  }

  async goto(url, options = {}) {
    const timeout = options.timeout ?? 45000;
    const pending = this.waitForLoad(timeout);
    try {
      const result = await this.app.cdp.send("Page.navigate", { url }, this.sessionId);
      if (result.errorText) throw new Error(result.errorText);
      await pending.promise;
      await this.refreshMainFrame();
    } catch (error) {
      pending.cancel();
      throw error;
    }
  }

  async startScreencast(onFrame, { width = 960, height = 540, quality = 60 } = {}) {
    this.offScreencast?.();
    this.offScreencast = this.app.cdp.on("Page.screencastFrame", (params, sessionId) => {
      if (sessionId !== this.sessionId) return;
      void this.app.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }, this.sessionId).catch(() => {});
      onFrame(Buffer.from(params.data, "base64"));
    });
    await this.app.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      maxWidth: width,
      maxHeight: height,
    }, this.sessionId);
  }

  async stopScreencast() {
    this.offScreencast?.();
    this.offScreencast = null;
    if (this.isClosed()) return;
    await this.app.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {});
  }

  async setViewportSize({ width, height }) {
    await this.app.cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
    }, this.sessionId);
  }
}

class ChromeContext {
  constructor({ cdp, child, version, userDataDir }) {
    this.cdp = cdp;
    this.child = child;
    this.version = version;
    this.userDataDir = userDataDir;
    this.disconnected = false;
    this.sessions = new Map();
    this.pageTargets = new Map();
    this.contexts = new Map();
    this.contextOwners = new Map();
    this.frameHosts = new Map();
    this.frameParents = new Map();
    this.initScripts = [];
    this.events = createEmitter();
    this.closePromise = null;
  }

  on(event, handler) {
    this.events.on(event, handler);
  }

  emit(event, arg) {
    this.events.emit(event, arg);
  }

  browser() {
    return {
      isConnected: () => !this.disconnected && this.child.exitCode == null && !this.child.signalCode,
      version: () => this.version,
    };
  }

  pages() {
    return [...this.pageTargets.values()].filter((page) => !page.isClosed());
  }

  async newCDPSession(page) {
    return {
      send: (method, params) => this.cdp.send(method, params || {}, page.sessionId),
      detach: async () => {},
    };
  }

  noteTree(sessionId, node) {
    const frame = node.frame;
    const hosts = this.frameHosts.get(frame.id) || new Set();
    hosts.add(sessionId);
    this.frameHosts.set(frame.id, hosts);
    if (frame.parentId) this.frameParents.set(frame.id, frame.parentId);
    else if (!this.frameParents.has(frame.id)) this.frameParents.set(frame.id, null);
    for (const child of node.childFrames || []) this.noteTree(sessionId, child);
  }

  async refreshTrees() {
    for (const session of this.sessions.values()) {
      if (session.type !== "page" && session.type !== "iframe") continue;
      try {
        const tree = await this.cdp.send("Page.getFrameTree", {}, session.sessionId);
        this.noteTree(session.sessionId, tree.frameTree);
      } catch {
        // 閉じたターゲットは次の操作で捨てる
      }
    }
  }

  async evaluateInFrame(frameId, expression) {
    const ctx = await this.ensureContext(frameId);
    const result = await this.cdp.send("Runtime.evaluate", {
      expression,
      contextId: ctx.contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, ctx.sessionId);
    if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
    return result.result?.value;
  }

  async ensureContext(frameId) {
    const existing = this.contexts.get(frameId);
    if (existing) return existing;
    await this.refreshTrees();
    const raced = this.contexts.get(frameId);
    if (raced) return raced;
    const hosts = [...(this.frameHosts.get(frameId) || [])];
    let lastError = null;
    for (const sessionId of hosts) {
      try {
        const created = await this.cdp.send("Page.createIsolatedWorld", {
          frameId,
          worldName: "treasure-finder",
          grantUniveralAccess: true,
        }, sessionId);
        const ctx = { sessionId, contextId: created.executionContextId };
        this.contexts.set(frameId, ctx);
        return ctx;
      } catch (error) {
        lastError = error;
      }
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(50);
      const found = this.contexts.get(frameId);
      if (found) return found;
    }
    throw lastError || new Error("フレームの実行コンテキストがありません");
  }

  async iframeRect(frameId, parentId) {
    const parent = await this.ensureContext(parentId);
    await this.cdp.send("DOM.getDocument", { depth: 0, pierce: true }, parent.sessionId);
    const owner = await this.cdp.send("DOM.getFrameOwner", { frameId }, parent.sessionId);
    const resolved = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: owner.backendNodeId,
    }, parent.sessionId);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("iframe の要素を取得できません");
    try {
      const result = await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          const rect = this.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }`,
        returnByValue: true,
      }, parent.sessionId);
      if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
      return result.result.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, parent.sessionId).catch(() => {});
    }
  }

  async evaluateOnFrameElement(frameId, parentId, fn, arg) {
    const parent = await this.ensureContext(parentId);
    await this.cdp.send("DOM.getDocument", { depth: 0, pierce: true }, parent.sessionId);
    const owner = await this.cdp.send("DOM.getFrameOwner", { frameId }, parent.sessionId);
    const resolved = await this.cdp.send("DOM.resolveNode", {
      backendNodeId: owner.backendNodeId,
    }, parent.sessionId);
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error("iframe の要素を取得できません");
    try {
      const payload = {
        objectId,
        functionDeclaration: `function(arg) { return (${fn.toString()})(this, arg); }`,
        awaitPromise: true,
        returnByValue: true,
      };
      if (arg !== undefined) payload.arguments = [{ value: arg }];
      const result = await this.cdp.send("Runtime.callFunctionOn", payload, parent.sessionId);
      if (result.exceptionDetails) throw new Error(exceptionText(result.exceptionDetails));
      return result.result?.value;
    } finally {
      await this.cdp.send("Runtime.releaseObject", { objectId }, parent.sessionId).catch(() => {});
    }
  }

  pageBySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this.pageTargets.get(session.targetId) || null;
  }

  adoptPage(sessionId, targetId, frame) {
    const current = this.pageTargets.get(targetId);
    if (current && !current.closed) {
      current.sessionId = sessionId;
      current.mainFrameId = frame.id;
      current.currentUrl = frame.url || current.currentUrl;
      return current;
    }
    const page = new ChromePage(this, sessionId, targetId);
    page.mainFrameId = frame.id;
    page.currentUrl = frame.url || "";
    this.pageTargets.set(targetId, page);
    return page;
  }

  async initTarget(sessionId, info) {
    if (info.type !== "page" && info.type !== "iframe") return;
    if (info.url?.startsWith("devtools://")) return;
    try {
      await this.cdp.send("Page.enable", {}, sessionId);
      await this.cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId);
      await this.cdp.send("Runtime.enable", {}, sessionId);
      for (const source of this.initScripts) {
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
      }
      const tree = await this.cdp.send("Page.getFrameTree", {}, sessionId);
      this.noteTree(sessionId, tree.frameTree);
      if (info.type === "page") this.adoptPage(sessionId, info.targetId, tree.frameTree.frame);
    } catch {
      // ページ以外のターゲットは撮影に使わない
    }
  }

  start() {
    this.cdp.on("Target.attachedToTarget", (params) => {
      const info = params.targetInfo || {};
      this.sessions.set(params.sessionId, {
        sessionId: params.sessionId,
        type: info.type,
        targetId: info.targetId,
        url: info.url,
      });
      if (params.waitingForDebugger) {
        void this.cdp.send("Runtime.runIfWaitingForDebugger", {}, params.sessionId).catch(() => {});
      }
      void this.initTarget(params.sessionId, info);
    });
    this.cdp.on("Target.detachedFromTarget", (params) => {
      const session = this.sessions.get(params.sessionId);
      this.sessions.delete(params.sessionId);
      if (!session) return;
      const page = this.pageTargets.get(session.targetId);
      if (page && session.sessionId === page.sessionId && !page.closed) {
        page.closed = true;
        page.emit("close");
      }
    });
    this.cdp.on("Runtime.executionContextCreated", (params, sessionId) => {
      const context = params.context || {};
      const aux = context.auxData || {};
      if (!aux.isDefault || !aux.frameId) return;
      this.contexts.set(aux.frameId, { sessionId, contextId: context.id });
      this.contextOwners.set(`${sessionId}:${context.id}`, aux.frameId);
    });
    this.cdp.on("Runtime.executionContextDestroyed", (params, sessionId) => {
      const key = `${sessionId}:${params.executionContextId}`;
      const frameId = this.contextOwners.get(key);
      this.contextOwners.delete(key);
      const current = frameId ? this.contexts.get(frameId) : null;
      if (current && current.contextId === params.executionContextId && current.sessionId === sessionId) {
        this.contexts.delete(frameId);
      }
    });
    this.cdp.on("Runtime.executionContextsCleared", (_params, sessionId) => {
      for (const [frameId, ctx] of this.contexts) {
        if (ctx.sessionId === sessionId) this.contexts.delete(frameId);
      }
    });
    this.cdp.on("Page.frameNavigated", (params, sessionId) => {
      const page = this.pageBySession(sessionId);
      if (!page || params.frame?.parentId) return;
      page.mainFrameId = params.frame.id;
      page.currentUrl = params.frame.url || page.currentUrl;
      page.emit("framenavigated", page.mainFrame());
    });
    this.cdp.on("Treasure.disconnected", () => {
      this.markDisconnected();
    });
    return this.activate();
  }

  async activate() {
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    const deadline = Date.now() + 15000;
    let requestedPage = false;
    while (Date.now() < deadline) {
      if (this.child.exitCode != null || this.child.signalCode) {
        throw new Error("Chromeがすぐに終了しました");
      }
      if (this.pageTargets.size) return;
      if (!requestedPage && Date.now() + 12000 > deadline) {
        requestedPage = true;
        await this.cdp.send("Target.createTarget", { url: "about:blank" }).catch(() => {});
      }
      await delay(50);
    }
    throw new Error("Chromeのウィンドウが開きませんでした");
  }

  async addInitScript(fn) {
    const source = `(${fn.toString()})();`;
    this.initScripts.push(source);
    for (const session of this.sessions.values()) {
      if (session.type !== "page" && session.type !== "iframe") continue;
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, session.sessionId).catch(() => {});
      await this.cdp.send("Runtime.evaluate", {
        expression: source,
        returnByValue: true,
      }, session.sessionId).catch(() => {});
    }
  }

  async newPage() {
    const created = await this.cdp.send("Target.createTarget", { url: "about:blank" });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const page = this.pageTargets.get(created.targetId);
      if (page && !page.isClosed()) return page;
      await delay(50);
    }
    throw new Error("新しいページを開けませんでした");
  }

  markDisconnected() {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const page of this.pageTargets.values()) {
      if (!page.closed) {
        page.closed = true;
        page.emit("close");
      }
    }
    this.emit("close");
  }

  close() {
    if (!this.closePromise) this.closePromise = this.shutdown();
    return this.closePromise;
  }

  async shutdown() {
    try {
      await this.cdp.send("Browser.close", {}, undefined, 5000);
    } catch {
      // 切断と同時に失敗することがある
    }
    await waitForExit(this.child, 5000);
    if (this.child.exitCode == null && !this.child.signalCode) await stopChild(this.child);
    this.markDisconnected();
    try {
      this.cdp.close();
    } catch {
      // すでに閉じている
    }
  }
}

export async function launchChrome({ executable, userDataDir, profileArgs, headless = false, sandbox = false }) {
  const directory = path.resolve(userDataDir);
  await fs.mkdir(directory, { recursive: true });
  await fs.rm(path.join(directory, "DevToolsActivePort"), { force: true }).catch(() => {});
  const args = chromeLaunchArgs({
    userDataDir: directory,
    profileArgs,
    headless,
    sandbox,
  });
  let log = "";
  const child = spawn(executable, args, chromeProcessOptions());
  const append = (chunk) => {
    log = `${log}${chunk}`.slice(-4000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => {
    log = `${log}\n${error.message}`.slice(-4000);
  });
  let app = null;
  try {
    const version = await waitForDevtools(directory, child, () => log, 20000);
    const wsUrl = new URL(version.webSocketDebuggerUrl);
    wsUrl.hostname = "127.0.0.1";
    const socket = await connectWebSocket(wsUrl.toString());
    const cdp = new CdpClient(socket);
    app = new ChromeContext({
      cdp,
      child,
      version: productVersion(version.Browser),
      userDataDir: directory,
    });
    await app.start();
    return app;
  } catch (error) {
    if (app) await app.close().catch(() => {});
    else await stopChild(child);
    const detail = log.trim();
    if (detail && !String(error.message || error).includes(detail)) {
      error.message = `${error.message}\n${detail}`;
    }
    throw error;
  }
}
