import fs from "node:fs/promises";
import path from "node:path";
import { captureVideoFrame, findBestVideo } from "./capture.js";
import { launchChrome } from "./chrome-app.js";
import { CAPTURES_DIR, USER_DATA_ROOT } from "./config-store.js";
import { resolveProfileId } from "./domain.js";
import { AppError } from "./errors.js";
import { explainLaunchError, findSystemChrome, resolveEngine } from "./engines.js";
import { buildFilename } from "./filename.js";
import { jpegSize } from "./jpeg.js";
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  JPEG_QUALITY,
  buildLaunchArgs,
  getProfile,
} from "./profiles.js";
import { userAgentOverride } from "./ua.js";

const ACCEPT_LANGUAGE = "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7";

function createLock() {
  let current = Promise.resolve();
  return function exclusive(task) {
    const next = current.then(task, task);
    current = next.then(() => undefined, () => undefined);
    return next;
  };
}

const LIVE_GRAB = { width: 640, height: 360, quality: 0.7 };
const LIVE_VIDEO_MS = 100;
const LIVE_PAGE_MS = 250;
const LIVE_LOCATE_MS = 1500;
const LIVE_LOAD_RETRIES = 12;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ページ側で実行される。読み込み中は loading を返し、再生位置が変わって
// いなければ画像を作らない。映像を読み出せないときは null になる。
function grabVideoFrame(video, options) {
  if (video.readyState < 2 || !video.videoWidth) return { loading: true };
  if (video.mediaKeys) return null;
  if (options.after !== null && video.currentTime === options.after) return { time: video.currentTime };
  const scale = Math.min(1, options.width / video.videoWidth, options.height / video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  try {
    const url = canvas.toDataURL("image/jpeg", options.quality);
    return { time: video.currentTime, data: url.slice(url.indexOf(",") + 1) };
  } catch {
    return null;
  }
}

export class BrowserManager {
  constructor(store, options = {}) {
    this.store = store;
    this.userDataRoot = options.userDataRoot || USER_DATA_ROOT;
    this.capturesDir = options.capturesDir || CAPTURES_DIR;
    const lock = createLock();
    // 操作が終わるたびに、ライブプレビューを今のページへ付け直す
    this.exclusive = (task) => {
      const result = lock(task);
      result.then(() => this.refreshLive(), () => this.refreshLive());
      return result;
    };
    this.liveViewers = new Set();
    this.livePage = null;
    this.liveFrame = null;
    this.liveMode = null;
    this.liveViewport = null;
    this.liveTarget = null;
    this.liveRun = Promise.resolve();
    this.liveChain = Promise.resolve();
    this.context = null;
    this.page = null;
    this.boundPages = new WeakSet();
    this.engineInfo = null;
    this.profileId = null;
    this.version = null;
    this.userAgent = null;
    this.userDataDir = null;
    this.launching = false;
    this.capturing = false;
    this.suspendProfileSync = false;
    this.sandboxFallback = false;
    this.lastError = null;
  }

  async status() {
    const config = await this.store.load();
    let url = "";
    let domain = "";
    const page = this.page && !this.page.isClosed() ? this.page : null;
    if (page) {
      try {
        url = page.url();
        if (/^https?:/i.test(url)) domain = new URL(url).hostname;
      } catch {
        url = "";
      }
    }
    const connected = Boolean(this.context?.browser()?.isConnected() && page);
    const profile = this.profileId
      ? getProfile(config, this.profileId)
      : getProfile(config, config.defaultProfile);
    return {
      browserOpen: connected,
      launching: this.launching,
      capturing: this.capturing,
      engine: this.engineInfo?.key || null,
      engineLabel: this.engineInfo?.label || null,
      configuredEngine: config.engine,
      version: this.version,
      userAgent: this.userAgent,
      profileId: connected ? this.profileId : null,
      profileLabel: profile?.label || null,
      url,
      domain,
      lastError: this.lastError,
      capturesDir: this.capturesDir,
      userDataDir: this.userDataDir,
      sandboxFallback: this.sandboxFallback,
      live: this.livePage
        ? { mode: this.liveMode, viewport: this.liveViewport, target: this.liveTarget }
        : null,
      capture: {
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        quality: JPEG_QUALITY,
      },
    };
  }

  navigate(url) {
    return this.exclusive(async () => {
      const target = new URL(url);
      const config = await this.store.load();
      const profileId = resolveProfileId(target.hostname, config.domainProfiles, config.defaultProfile);
      await this.ensureContext(profileId);
      const page = await this.currentPage();
      await this.prepareCurrentPage();
      this.lastError = null;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (error) {
        this.lastError = error.message || String(error);
        throw new AppError(this.lastError, 502, "NAVIGATION_FAILED");
      }
      await this.prepareCurrentPage();
    });
  }

  capture() {
    return this.exclusive(async () => {
      const page = await this.requirePage();
      this.capturing = true;
      this.suspendProfileSync = true;
      await this.refreshLive();
      try {
        await this.prepareCurrentPage();
        const buffer = await captureVideoFrame(page);
        const size = jpegSize(buffer);
        const host = pageHost(page.url());
        const config = await this.store.load();
        const named = await buildFilename({
          config,
          page,
          hostname: host,
        });
        await fs.mkdir(this.capturesDir, { recursive: true });
        const file = await uniqueName(this.capturesDir, named.filename);
        await fs.writeFile(path.join(this.capturesDir, file), buffer);
        this.lastError = null;
        return {
          file,
          width: size.width,
          height: size.height,
          bytes: buffer.length,
          strategy: named.strategy,
          url: page.url(),
        };
      } catch (error) {
        this.lastError = error.message || String(error);
        throw error;
      } finally {
        this.capturing = false;
        this.suspendProfileSync = false;
      }
    });
  }

  addLiveViewer(onFrame) {
    this.liveViewers.add(onFrame);
    if (this.liveFrame) onFrame(this.liveFrame);
    void this.refreshLive();
    return () => {
      this.liveViewers.delete(onFrame);
      void this.refreshLive();
    };
  }

  refreshLive() {
    this.liveChain = this.liveChain.then(() => this.applyLive()).catch(() => {});
    return this.liveChain;
  }

  async applyLive() {
    const page = this.page && !this.page.isClosed() ? this.page : null;
    const wanted = this.liveViewers.size && !this.capturing ? page : null;
    if (wanted === this.livePage) return;
    this.livePage = null;
    await this.liveRun;
    this.liveFrame = null;
    this.liveMode = null;
    this.liveViewport = null;
    this.liveTarget = null;
    if (!wanted) return;
    this.livePage = wanted;
    this.liveRun = this.runLive(wanted);
  }

  publishLive(frame) {
    this.liveFrame = frame;
    for (const viewer of this.liveViewers) viewer(frame);
  }

  // 撮影と同じ video の映像だけを canvas で縮小して流す。読み込み中は何回か
  // 待ち直し、それでも映像を読み出せないページ（CORS のない別オリジンなど）
  // では、screencast をその video の位置で切り抜く。
  async runLive(page) {
    const active = () => this.livePage === page && !page.isClosed();
    let video = null;
    let locatedAt = 0;
    let tryVideo = false;
    let lastTime = null;
    let lastUrl = null;
    let loadingTries = 0;
    let screencasting = false;
    try {
      while (active()) {
        if (Date.now() - locatedAt >= LIVE_LOCATE_MS) {
          locatedAt = Date.now();
          video = await findBestVideo(page).catch(() => null);
          const box = video ? await video.locator.boundingBox().catch(() => null) : null;
          this.liveTarget = box && box.width >= 1 && box.height >= 1 ? box : null;
          tryVideo = Boolean(video);
          if (page.url() !== lastUrl) {
            lastUrl = page.url();
            loadingTries = 0;
          }
        }
        if (!video && loadingTries < LIVE_LOAD_RETRIES) {
          // 読み込み直後は video がまだ候補にならないので、すぐ探し直す
          loadingTries += 1;
          locatedAt = 0;
          if (!screencasting) this.liveMode = "loading";
          await delay(LIVE_PAGE_MS);
          continue;
        }
        const grabbed = tryVideo
          ? await video.locator.evaluate(grabVideoFrame, { ...LIVE_GRAB, after: lastTime }).catch(() => null)
          : null;
        if (!active()) break;
        if (grabbed?.loading && loadingTries < LIVE_LOAD_RETRIES) {
          loadingTries += 1;
          if (!screencasting) this.liveMode = "loading";
          await delay(LIVE_PAGE_MS);
          continue;
        }
        if (grabbed && !grabbed.loading) {
          loadingTries = 0;
          if (screencasting) {
            screencasting = false;
            await page.stopScreencast();
          }
          this.liveMode = "video";
          lastTime = grabbed.time;
          if (grabbed.data) this.publishLive(Buffer.from(grabbed.data, "base64"));
          await delay(LIVE_VIDEO_MS);
          continue;
        }
        tryVideo = false;
        lastTime = null;
        this.liveMode = "page";
        if (!screencasting) {
          screencasting = true;
          await page.startScreencast((frame, viewport) => {
            if (this.livePage !== page || this.liveMode !== "page") return;
            if (viewport.width && viewport.height) this.liveViewport = viewport;
            this.publishLive(frame);
          }).catch(() => {
            screencasting = false;
          });
        }
        await delay(LIVE_PAGE_MS);
      }
    } finally {
      if (screencasting) await page.stopScreencast();
    }
  }

  syncWithConfig() {
    return this.exclusive(() => this.syncProfile());
  }

  close() {
    return this.exclusive(() => this.closeContext());
  }

  async ensureContext(profileId) {
    const config = await this.store.load();
    const engine = await resolveEngine(config);
    const connected = Boolean(this.context?.browser()?.isConnected());
    if (connected && this.profileId === profileId && this.engineInfo?.key === engine.key) {
      await this.currentPage();
      return;
    }
    await this.launch(engine, profileId, config);
  }

  async launch(engine, profileId, config, sandbox = false) {
    this.launching = true;
    try {
      await this.closeContext();
      const profile = getProfile(config, profileId);
      const userDataDir = path.join(this.userDataRoot, engine.key);
      await fs.mkdir(userDataDir, { recursive: true });
      let context;
      try {
        context = await launchChrome({
          executable: engine.executablePath,
          userDataDir,
          profileArgs: buildLaunchArgs(profile),
          headless: process.env.KOMA_HEADLESS === "1",
          sandbox,
        });
      } catch (error) {
        const text = String(error?.message || error);
        if (!sandbox && /sandbox|zygote|namespace/i.test(text)) {
          this.sandboxFallback = true;
          await this.launch(engine, profileId, config, true);
          return;
        }
        throw explainLaunchError(error);
      }
      context.on("close", () => {
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
        this.profileId = null;
        void this.refreshLive();
      });
      this.context = context;
      this.engineInfo = engine;
      this.profileId = profileId;
      this.userDataDir = context.userDataDir || userDataDir;
      this.sandboxFallback = sandbox || this.sandboxFallback;
      this.version = context.browser()?.version() || null;
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, "webdriver", {
          configurable: true,
          get: () => undefined,
        });
      });
      this.page = context.pages()[0] || await context.newPage();
      this.bindPage(this.page);
      await this.prepareCurrentPage();
    } finally {
      this.launching = false;
    }
  }

  bindPage(page) {
    if (!page || this.boundPages.has(page)) return;
    this.boundPages.add(page);
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      if (this.suspendProfileSync) return;
      void this.exclusive(() => this.syncProfile());
    });
    page.on("close", () => {
      if (this.page === page) this.page = null;
      void this.refreshLive();
    });
  }

  async currentPage() {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.context || !this.context.browser()?.isConnected()) return null;
    const open = this.context.pages().filter((page) => !page.isClosed());
    this.page = open[0] || await this.context.newPage();
    this.bindPage(this.page);
    return this.page;
  }

  async requirePage() {
    const page = await this.currentPage();
    if (!page) throw new AppError("先にページを開いてください", 400, "NO_PAGE");
    return page;
  }

  async prepareCurrentPage() {
    const page = await this.currentPage();
    if (!page) return;
    await page.setViewportSize({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }).catch(() => {});
    const client = await page.context().newCDPSession(page);
    try {
      await client.send("Emulation.setDeviceMetricsOverride", {
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: CAPTURE_WIDTH,
        screenHeight: CAPTURE_HEIGHT,
      });
      if (this.engineInfo?.overrideUa && this.version) {
        await client.send(
          "Network.setUserAgentOverride",
          userAgentOverride(this.version, ACCEPT_LANGUAGE),
        );
      }
      this.userAgent = await page.evaluate(() => navigator.userAgent).catch(() => this.userAgent);
    } finally {
      await client.detach().catch(() => {});
    }
  }

  async syncProfile() {
    if (this.suspendProfileSync) return;
    const page = await this.currentPage();
    if (!page) return;
    const url = page.url();
    if (!/^https?:/i.test(url)) return;
    const config = await this.store.load();
    const engine = await resolveEngine(config);
    const desired = resolveProfileId(new URL(url).hostname, config.domainProfiles, config.defaultProfile);
    const connected = Boolean(this.context?.browser()?.isConnected());
    if (connected && desired === this.profileId && engine.key === this.engineInfo?.key) return;
    await this.ensureContext(desired);
    const next = await this.currentPage();
    if (next && next.url() !== url) {
      await next.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await this.prepareCurrentPage();
    }
  }

  async closeContext() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.profileId = null;
    this.userAgent = null;
    if (context) await context.close().catch(() => {});
  }
}

function pageHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

async function uniqueName(directory, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, -ext.length);
  let candidate = filename;
  let index = 2;
  while (true) {
    try {
      await fs.access(path.join(directory, candidate));
      candidate = `${stem}-${index}${ext}`;
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export function installedChrome() {
  const executable = findSystemChrome();
  return executable ? { path: executable } : null;
}
