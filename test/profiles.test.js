import assert from "node:assert/strict";
import test from "node:test";
import { buildLaunchArgs, getProfile, sanitizeConfig } from "../src/profiles.js";

test("ソフトウェア描画の起動引数にはGPU無効が含まれる", () => {
  const config = sanitizeConfig({});
  const args = buildLaunchArgs(getProfile(config, "no-gpu"));
  assert.ok(args.includes("--disable-gpu"));
  assert.ok(args.includes("--disable-accelerated-video-decode"));
  assert.equal(args.filter((arg) => arg === "--force-device-scale-factor=1").length, 1);
});

test("以前の Playwright Chromium 指定は自動に戻す", () => {
  const config = sanitizeConfig({ engine: "chromium" });
  assert.equal(config.engine, "auto");
});

test("ドメイン指定とカスタム引数を検証する", () => {
  const config = sanitizeConfig({
    engine: "chrome",
    defaultProfile: "no-gpu",
    domainProfiles: { "WWW.Example.com": "swiftshader" },
    customProfiles: [{ id: "soft-gl", label: "独自", args: ["--use-gl=angle"] }],
  });
  assert.equal(config.domainProfiles["www.example.com"], "swiftshader");
  assert.equal(config.defaultProfile, "no-gpu");
  assert.equal(config.customProfiles[0].args[0], "--use-gl=angle");
  assert.throws(() => sanitizeConfig({
    customProfiles: [{ id: "bad", label: "bad", args: ["rm -rf"] }],
  }), /起動引数/);
});
