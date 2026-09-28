import assert from "node:assert/strict";
import test from "node:test";
import { hostFromInput, normalizeUrl, resolveProfileId } from "../src/domain.js";

test("ドメインはサブドメインより長い一致より、登録そのものを優先する", () => {
  const rules = {
    "example.com": "no-gpu",
    "www.example.com": "swiftshader",
  };
  assert.equal(resolveProfileId("www.example.com", rules, "default"), "swiftshader");
  assert.equal(resolveProfileId("video.example.com", rules, "default"), "no-gpu");
  assert.equal(resolveProfileId("example.org", rules, "default"), "default");
});

test("URLとドメインの表記を揃える", () => {
  assert.equal(normalizeUrl("example.com/watch"), "https://example.com/watch");
  assert.equal(hostFromInput("HTTPS://WWW.Example.com/a"), "www.example.com");
  assert.throws(() => normalizeUrl("file:///tmp/a"), /http/);
  assert.throws(() => hostFromInput("localhost"), /example\.com/);
});
