import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserManager, installedChrome } from "./browser-manager.js";
import {
  CAPTURES_DIR,
  ConfigStore,
  PUBLIC_DIR,
} from "./config-store.js";
import { normalizeUrl } from "./domain.js";
import { AppError } from "./errors.js";
import { allProfiles } from "./profiles.js";

const PORT = Number(process.env.PORT || 47321);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function streamLive(res, manager) {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store",
  });
  const remove = manager.addLiveViewer((jpeg) => {
    // 受け取りが追いつかないときは、古いフレームを積まずに捨てる
    if (res.writableNeedDrain) return;
    res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write("\r\n");
  });
  res.on("close", remove);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new AppError("リクエストが大きすぎます", 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("JSONが壊れています", 400));
      }
    });
    req.on("error", reject);
  });
}

export function isEmbedded(file) {
  return /(?:\$bunfs|~bun)(?:[/\\]|$)/i.test(String(file));
}

function pathApi(root) {
  return /^[A-Za-z]:[\\/]/.test(root) || root.includes("\\") ? path.win32 : path.posix;
}

export function safeFile(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^[/\\]+/, "");
  if (isEmbedded(root)) {
    const api = pathApi(root);
    const base = api.normalize(root);
    const file = api.normalize(api.join(base, relative));
    const prefix = base.endsWith(api.sep) ? base : `${base}${api.sep}`;
    if (file !== base && !file.startsWith(prefix)) return null;
    return file;
  }
  const file = path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (file !== root && !file.startsWith(prefix)) return null;
  return file;
}

async function readEmbedded(file) {
  if (typeof Bun !== "undefined" && typeof Bun.file === "function") {
    const blob = Bun.file(file);
    if (await blob.exists()) return Buffer.from(await blob.arrayBuffer());
  }
  return fsp.readFile(file);
}

async function serveEmbedded(req, res, file) {
  let data;
  try {
    data = await readEmbedded(file);
  } catch {
    sendJson(res, { error: "見つかりません" }, 404);
    return;
  }
  const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range && data.length > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (match[1] === "" && match[2] === "")) {
      res.writeHead(416, { "Content-Range": `bytes */${data.length}` });
      res.end();
      return;
    }
    let start = match[1] === "" ? Math.max(0, data.length - Number(match[2])) : Number(match[1]);
    let end = match[2] === "" || match[1] === "" ? data.length - 1 : Number(match[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= data.length) {
      res.writeHead(416, { "Content-Range": `bytes */${data.length}` });
      res.end();
      return;
    }
    end = Math.min(end, data.length - 1);
    const slice = data.subarray(start, end + 1);
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": slice.length,
      "Content-Range": `bytes ${start}-${end}/${data.length}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    res.end(slice);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": data.length,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

function serveFile(req, res, file) {
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) {
      sendJson(res, { error: "見つかりません" }, 404);
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range && stat.size > 0) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (match[1] === "" && match[2] === "")) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      let start = match[1] === "" ? Math.max(0, stat.size - Number(match[2])) : Number(match[1]);
      let end = match[2] === "" || match[1] === "" ? stat.size - 1 : Number(match[2]);
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stat.size - 1);
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(file, { start, end }).on("error", () => {
        if (!res.headersSent) sendJson(res, { error: "見つかりません" }, 404);
        else res.destroy();
      }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).on("error", () => {
      if (!res.headersSent) sendJson(res, { error: "見つかりません" }, 404);
      else res.destroy();
    }).pipe(res);
  });
}

async function listCaptures(directory) {
  let names = [];
  try {
    names = await fsp.readdir(directory);
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    if (!/^\d{8}-\d{6}-\d{3}(?:-\d+)?\.jpg$/.test(name)) continue;
    const stat = await fsp.stat(path.join(directory, name));
    files.push({ name, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, 30);
}

function openPath(target) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "explorer"
      : "xdg-open";
  const child = spawn(command, [target], { detached: true, stdio: "ignore" });
  child.unref();
}

export function createApp({ manager, store, publicDir = PUBLIC_DIR }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${HOST}`);
      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, { ...(await manager.status()), chrome: installedChrome() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/live") {
        streamLive(res, manager);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        const config = await store.load();
        const chrome = installedChrome();
        sendJson(res, { config, profiles: allProfiles(config), chrome });
        return;
      }
      if (req.method === "PUT" && url.pathname === "/api/config") {
        const body = await readBody(req);
        let saved;
        try {
          saved = await store.save(body.config ?? body);
        } catch (error) {
          throw new AppError(error.message, 400, "BAD_CONFIG");
        }
        await manager.syncWithConfig();
        sendJson(res, { config: saved, profiles: allProfiles(saved) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/navigate") {
        const body = await readBody(req);
        const target = normalizeUrl(body.url);
        await manager.navigate(target);
        sendJson(res, { ...(await manager.status()), url: target });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/capture") {
        const shot = await manager.capture();
        sendJson(res, shot);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/browser/close") {
        await manager.close();
        sendJson(res, await manager.status());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/captures") {
        sendJson(res, { files: await listCaptures(manager.capturesDir), directory: manager.capturesDir });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/captures/open") {
        await fsp.mkdir(manager.capturesDir, { recursive: true });
        openPath(manager.capturesDir);
        sendJson(res, { ok: true, directory: manager.capturesDir });
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/captures/")) {
        const name = path.basename(decodeURIComponent(url.pathname.slice("/captures/".length)));
        if (!/^\d{8}-\d{6}-\d{3}(?:-\d+)?\.jpg$/.test(name)) {
          sendJson(res, { error: "見つかりません" }, 404);
          return;
        }
        serveFile(req, res, path.join(manager.capturesDir, name));
        return;
      }
      if (req.method === "GET") {
        const file = safeFile(publicDir, url.pathname);
        if (!file) {
          sendJson(res, { error: "見つかりません" }, 404);
          return;
        }
        if (isEmbedded(file)) {
          await serveEmbedded(req, res, file);
          return;
        }
        serveFile(req, res, file);
        return;
      }
      sendJson(res, { error: "見つかりません" }, 404);
    } catch (error) {
      const status = error.status || 500;
      sendJson(res, { error: error.message || "失敗しました", code: error.code || "ERROR" }, status);
    }
  });
}

export function startServer({ port = PORT, host = HOST, open = true } = {}) {
  const store = new ConfigStore();
  const manager = new BrowserManager(store, { capturesDir: CAPTURES_DIR });
  const server = createApp({ manager, store });
  server.requestTimeout = 0;
  server.listen(port, host, () => {
    const address = `http://${host}:${port}`;
    console.log(`Treasure Finder  ${address}`);
    if (open && process.env.KOMA_NO_OPEN !== "1") openPath(address);
  });
  const shutdown = async () => {
    await manager.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  return { server, manager, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();
