import assert from "node:assert/strict";
import test from "node:test";
import { buildFilename, registerFilenameStrategy, timestampFilename } from "../src/filename.js";

test("ファイル名はローカル時刻のタイムスタンプ", () => {
  const name = timestampFilename(new Date(2026, 8, 28, 8, 5, 9, 42));
  assert.equal(name, "20260928-080509-042.jpg");
});

test("未実装の抽出方法はタイムスタンプに戻る", async () => {
  const result = await buildFilename({
    config: {
      filenameRules: {
        default: { type: "timestamp" },
        domains: { "example.com": { type: "selector", selector: "h1" } },
      },
    },
    hostname: "www.example.com",
    now: new Date(2026, 0, 2, 3, 4, 5, 6),
  });
  assert.equal(result.strategy, "timestamp");
  assert.equal(result.filename, "20260102-030405-006.jpg");
});

test("戦略を登録するとドメインルールから呼べる", async () => {
  registerFilenameStrategy("title", async ({ rule }) => `${rule.value}.jpg`);
  const result = await buildFilename({
    config: {
      filenameRules: {
        default: { type: "timestamp" },
        domains: { "example.com": { type: "title", value: "opening" } },
      },
    },
    hostname: "example.com",
    now: new Date(),
  });
  assert.equal(result, { filename: "opening.jpg", strategy: "title" });
});
