import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp, isEmbedded, safeFile } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("Windowsの同梱ファイルはB:\\~BUNから出ていけない", () => {
  const root = "B:\\~BUN\\root\\public";
  assert.equal(isEmbedded(root), true);
  assert.equal(safeFile(root, "/"), "B:\\~BUN\\root\\public\\index.html");
  assert.equal(safeFile(root, "/styles.css"), "B:\\~BUN\\root\\public\\styles.css");
  assert.equal(safeFile(root, "/../../windows/system.ini"), null);
  assert.equal(isEmbedded("/$bunfs/root/public/index.html"), true);
  assert.equal(safeFile("/$bunfs/root/public", "/app.js"), "/$bunfs/root/public/app.js");
  assert.equal(safeFile("/$bunfs/root/public", "/../../etc/passwd"), null);
});

async function jpeg(width, height) {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=${width}x${height}`,
    "-frames:v", "1", "-f", "mjpeg", "pipe:1",
  ]);
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout;
}

test("撮った JPEG を受け取って保存する", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "treasure-finder-server-"));
  const capturesDir = path.join(root, "captures");
  const settings = new SettingsStore(path.join(root, "config.json"));
  const server = createApp({ capturesDir, settings });
  const base = await listen(server);
  t.after(() => server.close());

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /このフレームを撮る/);

  const saved = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: await jpeg(1920, 1080),
  });
  assert.equal(saved.status, 201);
  const shot = await saved.json();
  assert.match(shot.file, /^\d{8}-\d{6}-\d{3}\.jpg$/);
  assert.deepEqual([shot.width, shot.height], [1920, 1080]);
  assert.deepEqual(await fs.readdir(capturesDir), [shot.file]);

  const listed = await (await fetch(`${base}/api/captures`)).json();
  assert.equal(listed.files[0].name, shot.file);
  assert.equal((await fetch(`${base}/captures/${shot.file}`)).status, 200);

  const small = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: await jpeg(1280, 720),
  });
  assert.equal(small.status, 400);

  const foreign = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", Origin: "https://example.com" },
    body: await jpeg(1920, 1080),
  });
  assert.equal(foreign.status, 403);

  const text = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "x",
  });
  assert.equal(text.status, 415);
  assert.equal((await fs.readdir(capturesDir)).length, 1);

  const put = (body) => fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await put({ screen: { width: 0, height: 720 }, videoAspect: { width: 16, height: 9 } })).status, 400);
  const changed = await put({ screen: { width: 1280, height: 720 }, videoAspect: { width: 4, height: 3 } });
  assert.equal(changed.status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), {
    screen: { width: 1280, height: 720 },
    videoAspect: { width: 4, height: 3 },
  });
  // 1280×720 の画面に 4:3 の動画を収めると 960×720
  const resized = await fetch(`${base}/api/captures`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: await jpeg(960, 720),
  });
  assert.equal(resized.status, 201);
});
