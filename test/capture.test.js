import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jpegSize } from "../src/jpeg.js";
import { createApp } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

// 画面共有の選択画面は、このタイトルのタブを自動で選ぶ
const TARGET_TITLE = "tf-target";

function findChromium() {
  const candidates = [process.env.CHROME_PATH];
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const name of readdirSync(cache).filter((entry) => /^chromium-\d+$/.test(entry)).sort().reverse()) {
      candidates.push(path.join(cache, name, "chrome-linux64", "chrome"));
    }
  } catch {
    // Playwright のブラウザが入っていない
  }
  candidates.push("/usr/bin/google-chrome-stable", "/usr/bin/chromium");
  return candidates.find((file) => {
    if (!file) return false;
    try {
      accessSync(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function page(body, background) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TARGET_TITLE}</title>
<style>html, body { margin: 0; height: 100%; background: ${background}; } ${body.style}</style></head>
<body>${body.html}</body></html>`;
}

const FULL = page({
  style: "video { width: 100vw; height: 100vh; object-fit: contain; display: block; }",
  html: '<video src="/sample.mp4" autoplay muted loop playsinline></video>',
}, "#000");

const WINDOWED = page({
  style: "body { display: grid; place-items: center; } video { width: 640px; height: 360px; }",
  html: '<video src="/sample.mp4" autoplay muted loop playsinline></video>',
}, "#2a241c");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const { result } = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description);
      return result.result.value;
    },
    navigate: (url) => send("Page.navigate", { url }),
    close: () => socket.close(),
  };
}

async function waitFor(tab, expression, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await tab.evaluate(expression)) return;
    await delay(200);
  }
  throw new Error(`待ちきれませんでした: ${expression}`);
}

const chromium = findChromium();

// 動画のページを開いたタブと操作パネルを用意して、パネルからそのタブを共有する
async function startSession(t, windowSize) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "treasure-finder-capture-"));
  const publicDir = path.join(root, "public");
  const capturesDir = path.join(root, "captures");
  await fs.cp(path.resolve("public"), publicDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, "full.html"), FULL);
  await fs.writeFile(path.join(publicDir, "windowed.html"), WINDOWED);

  const settings = new SettingsStore(path.join(root, "config.json"));
  const server = createApp({ capturesDir, publicDir, settings });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const port = 9400 + Math.floor(Math.random() * 400);
  const browser = spawn(chromium, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(root, "profile")}`,
    `--auto-select-tab-capture-source-by-title=${TARGET_TITLE}`,
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${windowSize}`,
    "--no-first-run",
    "about:blank",
  ], { stdio: "ignore" });
  t.after(() => browser.kill());

  const open = async (url) => {
    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
        return connect((await response.json()).webSocketDebuggerUrl);
      } catch {
        await delay(200);
      }
    }
    throw new Error("Chromium につながりません");
  };

  const target = await open(`${base}/full.html`);
  t.after(() => target.close());
  await waitFor(target, "document.querySelector('video')?.currentTime > 0.2");
  const panel = await open(`${base}/`);
  t.after(() => panel.close());

  await waitFor(panel, "document.querySelector('#share')?.disabled === false");
  // ヘッドレスでは最初の共有が選択画面で止まることがあるので、共有が始まるまで押し直す
  await panel.evaluate("document.querySelector('#share').click()");
  for (let i = 0; i < 3; i += 1) {
    const started = await waitFor(panel, "!document.querySelector('#stop').hidden", 5000).then(() => true, () => false);
    if (started) break;
    await panel.evaluate("document.querySelector('#share').click()");
  }
  await waitFor(panel, "!document.querySelector('#capture').disabled").catch(async (error) => {
    const state = await panel.evaluate(`JSON.stringify({
      share: document.querySelector('#share-line').textContent,
      error: document.querySelector('#banner').textContent,
    })`);
    throw new Error(`${error.message} ${state}`);
  });
  assert.equal(await panel.evaluate("document.querySelector('#share-line').textContent"), "タブを共有しています");

  const shoot = async () => {
    const before = await panel.evaluate("document.querySelector('#shot-meta').textContent");
    await panel.evaluate("document.querySelector('#capture').click()");
    await waitFor(panel, `(() => { const t = document.querySelector('#shot-meta').textContent; return t !== ${JSON.stringify(before)} && t.includes('KB'); })()`);
    return panel.evaluate(`({
      meta: document.querySelector('#shot-meta').textContent,
      warning: document.querySelector('#warning').hidden ? "" : document.querySelector('#warning').textContent,
      error: document.querySelector('#banner').hidden ? "" : document.querySelector('#banner').textContent,
      size: document.querySelector('#size-line').textContent,
    })`);
  };

  return { base, target, panel, capturesDir, shoot };
}

// 保存した JPEG の上から rows 行の平均の明るさ
function topLuma(file, rows) {
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-i", file, "-vf", `crop=iw:${rows}:0:0,scale=64:1`,
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ]);
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.reduce((sum, value) => sum + value, 0) / result.stdout.length;
}

const skip = !chromium && "Chromium が見つかりません";

test("共有したタブのフレームを 1920×1080 で保存する", { skip, timeout: 90000 }, async (t) => {
  const { base, target, capturesDir, shoot } = await startSession(t, "1920,1224");

  const full = await shoot();
  assert.equal(full.error, "");
  assert.match(full.meta, /1920×1080/);
  assert.equal(full.warning, "", JSON.stringify(full));

  // 共有したまま同じタブで別のページへ移っても、取り込みは続く
  await target.navigate(`${base}/windowed.html`);
  await waitFor(target, "document.querySelector('video')?.currentTime > 0.2");
  await delay(1000);
  const windowed = await shoot();
  assert.match(windowed.warning, /フルスクリーン/, JSON.stringify(windowed));

  const files = await fs.readdir(capturesDir);
  assert.equal(files.length, 2);
  for (const file of files) {
    assert.deepEqual(jpegSize(await fs.readFile(path.join(capturesDir, file))), { width: 1920, height: 1080 });
  }
  t.diagnostic(`フルスクリーン相当: ${full.size} / ウィンドウ内: ${windowed.size}`);
});

test("16:10 の画面では上下の帯を除いた中央の 16:9 を保存する", { skip, timeout: 90000 }, async (t) => {
  const { panel, capturesDir, shoot } = await startSession(t, "2560,1744");
  // 取り込みの上限が 1920×1200 に合わさるのを待つ
  await delay(1500);
  const shot = await shoot();
  assert.equal(shot.error, "");
  assert.equal(shot.warning, "", JSON.stringify(shot));
  assert.match(shot.size, /×1200$/);
  const [file] = await fs.readdir(capturesDir);
  // 帯が残っていれば上端が黒くなる。サンプル動画の上端は明るいカラーバー
  assert.ok(topLuma(path.join(capturesDir, file), 4) > 60);
  t.diagnostic(shot.size);

  // 動画の縦横比を 4:3 にすると、1440×1080 で保存する
  await panel.evaluate(`(() => {
    const select = document.querySelector('#aspect-preset');
    select.value = '4:3';
    select.dispatchEvent(new Event('change'));
    document.querySelector('#settings-form').requestSubmit();
    return true;
  })()`);
  await waitFor(panel, "document.querySelector('#output-tag').textContent.startsWith('1440×1080')");
  await delay(1500);
  const narrow = await shoot();
  assert.equal(narrow.error, "");
  assert.equal(narrow.warning, "", JSON.stringify(narrow));
  assert.match(narrow.meta, /1440×1080/);
  t.diagnostic(narrow.size);
});
