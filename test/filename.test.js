import assert from "node:assert/strict";
import test from "node:test";
import { timestampFilename } from "../src/filename.js";

test("ファイル名はローカル時刻のタイムスタンプ", () => {
  const name = timestampFilename(new Date(2026, 8, 28, 8, 5, 9, 42));
  assert.equal(name, "20260928-080509-042.jpg");
});
