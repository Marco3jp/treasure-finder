import assert from "node:assert/strict";
import test from "node:test";
import { chromeLaunchArgs, chromeProcessOptions } from "../src/chrome-app.js";

test("撮影用Chromeは専用のユーザーデータとデバッグポートで起動する", () => {
  const args = chromeLaunchArgs({
    userDataDir: "C:\\Treasure Finder\\data\\user-data\\chrome",
    platform: "win32",
    profileArgs: [
      "--no-first-run",
      "--disable-gpu",
      "--user-data-dir=C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data",
      "--remote-debugging-port=9222",
    ],
  });
  assert.equal(args.filter((arg) => arg.startsWith("--user-data-dir=")).length, 1);
  assert.equal(args[0], "--user-data-dir=C:/Treasure Finder/data/user-data/chrome");
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--disable-gpu"));
  assert.equal(args.at(-1), "about:blank");
  assert.equal(args.includes("--remote-debugging-port=9222"), false);
});

test("Windowsでは撮影用Chromeをデタッチしない", () => {
  assert.equal(chromeProcessOptions("win32").detached, false);
  assert.equal(chromeProcessOptions("linux").detached, true);
});
