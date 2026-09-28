import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserManager } from "../src/browser-manager.js";
import { ConfigStore } from "../src/config-store.js";
import { jpegSize } from "../src/jpeg.js";

function averageLuma(file) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-v", "error",
      "-i", file,
      "-vf", "scale=32:18",
      "-f", "rawvideo",
      "-pix_fmt", "gray",
      "pipe:1",
    ]);
    const chunks = [];
    let errorText = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      errorText += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(errorText || `ffmpeg exited ${code}`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      let sum = 0;
      for (const value of buffer) sum += value;
      resolve(sum / buffer.length);
    });
  });
}

function startFixture(directory) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/video") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><video src="/clip.mp4" autoplay muted loop playsinline style="width:640px;height:360px"></video>`);
      return;
    }
    if (url.pathname === "/frame") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><iframe src="/video" style="width:320px;height:180px;border:8px solid white"></iframe>`);
      return;
    }
    if (url.pathname === "/clip.mp4") {
      const file = path.join(directory, "clip.mp4");
      fs.stat(file).then((stat) => {
        const range = req.headers.range;
        const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
        let start = 0;
        let end = stat.size - 1;
        let status = 200;
        if (match) {
          start = match[1] === "" ? Math.max(0, stat.size - Number(match[2] || 0)) : Number(match[1]);
          end = match[2] === "" || match[1] === "" ? stat.size - 1 : Math.min(Number(match[2]), stat.size - 1);
          status = 206;
        }
        res.writeHead(status, {
          "Content-Type": "video/mp4",
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
        });
        fs.open(file).then((handle) => handle.createReadStream({ start, end })).then((stream) => {
          stream.pipe(res);
        }).catch(() => res.end());
      }).catch(() => {
        res.writeHead(404);
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function makeClip(directory) {
  const file = path.join(directory, "clip.mp4");
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "testsrc=size=1280x720:rate=30:duration=2",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      file,
    ]);
    let errorText = "";
    child.stderr.on("data", (chunk) => {
      errorText += chunk;
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText.slice(-500)));
    });
  });
  return file;
}

function browserCommandLine(userDataDir) {
  const hits = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let text = "";
    try {
      text = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").replaceAll("\0", " ");
    } catch {
      continue;
    }
    if (text.includes(userDataDir)) hits.push(text);
  }
  const main = hits.find((line) => line.includes("--user-data-dir") && !line.includes("--type="));
  if (!main) throw new Error("撮影用ブラウザのプロセスが見つかりません");
  return main;
}

test("video要素を画面サイズと無関係に1920x1080で残し、Cookieと起動方法を保つ", { timeout: 180000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "koma-capture-"));
  const store = new ConfigStore(path.join(root, "config.json"));
  const manager = new BrowserManager(store, {
    userDataRoot: path.join(root, "user-data"),
    capturesDir: path.join(root, "captures"),
  });
  await makeClip(root);
  const fixture = await startFixture(root);
  try {
    await manager.navigate(`http://127.0.0.1:${fixture.port}/video`);
    const page = await manager.currentPage();
    const metrics = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      ua: navigator.userAgent,
      scale: window.devicePixelRatio,
    }));
    assert.equal(metrics.width, 1920);
    assert.equal(metrics.height, 1080);
    assert.equal(metrics.scale, 1);
    assert.match(metrics.ua, /Chrome\/\d+/);
    assert.doesNotMatch(metrics.ua, /HeadlessChrome/);

    const planted = await page.evaluate(() => {
      document.cookie = "koma_kept=yes; path=/; max-age=31536000";
      return document.cookie;
    });
    assert.match(planted, /koma_kept=yes/);
    const shot = await manager.capture();
    const saved = path.join(root, "captures", shot.file);
    const size = jpegSize(await fs.readFile(saved));
    assert.deepEqual(size, { width: 1920, height: 1080 });
    assert.match(shot.file, /^\d{8}-\d{6}-\d{3}\.jpg$/);
    assert.ok(await averageLuma(saved) > 15, "撮影結果が真っ黒です");

    const config = await store.load();
    config.domainProfiles.localhost = "no-gpu";
    await store.save(config);
    await manager.navigate(`http://localhost:${fixture.port}/frame`);
    const noGpu = browserCommandLine(manager.userDataDir);
    assert.match(noGpu, /--disable-gpu/);
    assert.equal(manager.profileId, "no-gpu");
    const framed = await manager.capture();
    const framedSize = jpegSize(await fs.readFile(path.join(root, "captures", framed.file)));
    assert.deepEqual(framedSize, { width: 1920, height: 1080 });
    assert.ok(await averageLuma(path.join(root, "captures", framed.file)) > 15);

    await manager.close();
    await manager.navigate(`http://127.0.0.1:${fixture.port}/video`);
    const cookie = await manager.currentPage().then((open) => open.evaluate(() => document.cookie));
    assert.match(cookie, /koma_kept=yes/);
    assert.equal(manager.profileId, "default");
    assert.doesNotMatch(browserCommandLine(manager.userDataDir), /--disable-gpu/);
  } finally {
    await manager.close();
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
