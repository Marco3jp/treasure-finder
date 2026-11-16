import assert from "node:assert/strict";
import test from "node:test";
import { captureCap, edgeWarning, outputSize, placeVideo, sanitizeSettings, videoRect } from "../public/frame.js";

const DEFAULT = sanitizeSettings(null);
const custom = (screen, videoAspect) => sanitizeSettings({ screen, videoAspect });

test("16:10 の画面に 16:9 の動画なら、上下を削って中央の 2560×1440 を使う", () => {
  assert.deepEqual(videoRect({ width: 2560, height: 1600 }, DEFAULT), { x: 0, y: 80, width: 2560, height: 1440 });
});

test("21:9 の画面に 16:9 の動画なら、左右を削る", () => {
  assert.deepEqual(videoRect({ width: 3440, height: 1440 }, DEFAULT), { x: 440, y: 0, width: 2560, height: 1440 });
});

test("取り込みの上限は、動画の範囲が保存サイズに等倍で届く大きさ", () => {
  assert.deepEqual(captureCap(16 / 9, DEFAULT), { width: 1920, height: 1080 });
  assert.deepEqual(captureCap(16 / 10, DEFAULT), { width: 1920, height: 1200 });
  assert.deepEqual(captureCap(3 / 2, DEFAULT), { width: 1920, height: 1280 });
  assert.deepEqual(captureCap(3440 / 1440, DEFAULT), { width: 2580, height: 1080 });
});

test("上限どおりに取り込めれば等倍で保存する", () => {
  const place = placeVideo({ width: 1920, height: 1200 }, DEFAULT);
  assert.deepEqual(place.source, { x: 0, y: 60, width: 1920, height: 1080 });
  assert.deepEqual(place.target, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(place.scale, 1);
});

test("保存サイズは基準の画面に動画を収めた大きさ", () => {
  const screen = { width: 1920, height: 1080 };
  assert.deepEqual(outputSize(DEFAULT), { width: 1920, height: 1080 });
  assert.deepEqual(outputSize(custom(screen, { width: 4, height: 3 })), { width: 1440, height: 1080 });
  assert.deepEqual(outputSize(custom(screen, { width: 2.39, height: 1 })), { width: 1920, height: 803 });
  assert.deepEqual(outputSize(custom({ width: 2560, height: 1440 }, { width: 4, height: 3 })), { width: 1920, height: 1440 });
});

test("4:3 の動画は 16:10 の画面から左右を削って 1440×1080 に等倍で保存する", () => {
  const settings = custom({ width: 1920, height: 1080 }, { width: 4, height: 3 });
  assert.deepEqual(captureCap(16 / 10, settings), { width: 1728, height: 1080 });
  const place = placeVideo({ width: 1728, height: 1080 }, settings);
  assert.deepEqual(place.source, { x: 144, y: 0, width: 1440, height: 1080 });
  assert.deepEqual(place.target, { x: 0, y: 0, width: 1440, height: 1080 });
  assert.equal(place.scale, 1);
});

test("小さく取り込まれたら拡大率が1を超える", () => {
  assert.equal(placeVideo({ width: 1280, height: 720 }, DEFAULT).scale, 1.5);
});

test("読めない設定は初期値に戻す", () => {
  assert.deepEqual(sanitizeSettings({ screen: { width: "x", height: 99999 }, videoAspect: { width: -1 } }), {
    screen: { width: 1920, height: 1080 },
    videoAspect: { width: 16, height: 9 },
  });
});

// fill は (x, y) => [r, g, b]
function image(width, height, fill) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...fill(x, y), 255], (y * width + x) * 4);
  }
  return { data, width, height };
}

const stripes = (x) => (x % 20 < 10 ? [220, 40, 40] : [40, 200, 220]);

test("向かい合う縁が同じ背景色なら警告する", () => {
  const page = image(64, 36, (x, y) => (x > 16 && x < 48 && y > 9 && y < 27 ? stripes(x) : [42, 36, 28]));
  assert.match(edgeWarning(page), /フルスクリーン/);
});

test("黒帯や映像の縁では警告しない", () => {
  // 左端と右端で縞の色が違う映像
  assert.equal(edgeWarning(image(60, 34, (x, y) => (y < 4 || y > 29 ? [0, 0, 0] : stripes(x)))), null);
  assert.equal(edgeWarning(image(60, 34, stripes)), null);
});
