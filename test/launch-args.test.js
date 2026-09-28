import assert from "node:assert/strict";
import test from "node:test";
import { chromeLaunchArgs } from "../src/chrome-app.js";

test("撮影用Chromeは専用のユーザーデータとデバッグポートで起動する", () => {
  const args = chromeLaunchArgs({
    userDataDir: "C:\\TreasureFinder\\data\\user-data\\chrome",
    profileArgs: [
      "--no-first-run",
      "--disable-gpu",
      "--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data",
      "--remote-debugging-port=9222",
    ],
  });
  assert.equal(args.filter((arg) => arg.startsWith("--user-data-dir=")).length, 1);
  assert.match(args[0], /TreasureFinder/);
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--disable-gpu"));
  assert.equal(args.at(-1), "about:blank");
  assert.equal(args.includes("--remote-debugging-port=9222"), false);
});
