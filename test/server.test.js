import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BrowserManager } from "../src/browser-manager.js";
import { ConfigStore } from "../src/config-store.js";
import { createApp, isEmbedded, safeFile } from "../src/server.js";

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

test("設定の保存と操作パネルの配信", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "treasure-finder-server-"));
  const store = new ConfigStore(path.join(root, "config.json"));
  const manager = new BrowserManager(store, {
    userDataRoot: path.join(root, "user-data"),
    capturesDir: path.join(root, "captures"),
  });
  const server = createApp({ manager, store });
  const base = await listen(server);
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /この video を撮る/);

    const saved = await fetch(`${base}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: { engine: "chrome", domainProfiles: { "videos.example.com": "no-gpu" } },
      }),
    });
    assert.equal(saved.status, 200);
    const body = await saved.json();
    assert.equal(body.config.domainProfiles["videos.example.com"], "no-gpu");

    const rejected = await fetch(`${base}/api/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd" }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    server.close();
    await manager.close();
  }
});
