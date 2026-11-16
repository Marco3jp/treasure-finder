export const JPEG_QUALITY = 90;

// 保存サイズは、基準の画面に動画を縦横比を保って収めた大きさにする。
// 1920×1080 の画面なら、16:9 は 1920×1080、4:3 は 1440×1080、2.39:1 は 1920×803
export const DEFAULT_SETTINGS = {
  screen: { width: 1920, height: 1080 },
  videoAspect: { width: 16, height: 9 },
};

export const SCREEN_LIMITS = { min: 16, max: 7680 };

// これより明るい画素を含む縁は、黒い帯ではない
const BLACK_LUMA = 20;
// 縁の1列がこの幅に収まっていれば、同じ色で塗られているとみなす
const FLAT_SPREAD = 12;
const SAME_COLOR = 16;
// 縮めたフレームの端の数画素は、内側と色がずれることがある（ヘッドレスの Chromium では右端の列が暗くなった）
const EDGE_INSET = 2;

const even = (value) => Math.max(2, Math.ceil(value / 2) * 2);

export function ratio(size) {
  return size.width / size.height;
}

// box の中に縦横比 aspect の範囲を縦横比を保って一番大きく置いたときの位置
export function containRect(box, aspect) {
  if (box.width / box.height > aspect) {
    const width = box.height * aspect;
    return { x: (box.width - width) / 2, y: 0, width, height: box.height };
  }
  const height = box.width / aspect;
  return { x: 0, y: (box.height - height) / 2, width: box.width, height };
}

// フルスクリーンのプレイヤーは動画を画面の中央に縦横比を保って置くので、
// 画面と動画の縦横比が分かれば、取り込んだフレームのどこに動画があるか決まる
export function videoRect(frame, settings = DEFAULT_SETTINGS) {
  return containRect(frame, ratio(settings.videoAspect));
}

export function outputSize(settings = DEFAULT_SETTINGS) {
  const rect = containRect(settings.screen, ratio(settings.videoAspect));
  return { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
}

// 縦横比 screenAspect の画面を取り込んだとき、動画の範囲が保存サイズに等倍で届く大きさ。
// Chrome はこれを上限に、タブを一定の刻みで縮めた候補の中から取り込むサイズを選ぶ
export function captureCap(screenAspect, settings = DEFAULT_SETTINGS) {
  const target = outputSize(settings);
  if (screenAspect > ratio(settings.videoAspect)) {
    return { width: even(target.height * screenAspect), height: even(target.height) };
  }
  return { width: even(target.width), height: even(target.width / screenAspect) };
}

// 取り込んだフレームの動画の範囲を、保存する画像のどこに描くか
export function placeVideo(frame, settings = DEFAULT_SETTINGS) {
  const source = videoRect(frame, settings);
  const target = containRect(outputSize(settings), ratio(source));
  return { source, target, scale: target.width / source.width };
}

function luma(data, offset) {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

function lineStats(image, horizontal, index) {
  const { data, width, height } = image;
  const length = horizontal ? width : height;
  let min = Infinity;
  let max = -Infinity;
  const sum = [0, 0, 0];
  for (let i = EDGE_INSET; i < length - EDGE_INSET; i += 1) {
    const x = horizontal ? i : index;
    const y = horizontal ? index : i;
    const offset = (y * width + x) * 4;
    const value = luma(data, offset);
    if (value < min) min = value;
    if (value > max) max = value;
    sum[0] += data[offset];
    sum[1] += data[offset + 1];
    sum[2] += data[offset + 2];
  }
  return { min, max, color: sum.map((value) => value / (length - EDGE_INSET * 2)) };
}

function flatColor(stats) {
  return stats.max - stats.min <= FLAT_SPREAD && stats.max > BLACK_LUMA;
}

function sameColor(a, b) {
  return a.color.every((value, i) => Math.abs(value - b.color[i]) <= SAME_COLOR);
}

// image は取り込んだフレームを縮めた RGBA。
// 向かい合う縁が黒以外の同じ色で塗られていたら、ページの背景が写っている
export function edgeWarning(image) {
  const top = lineStats(image, true, EDGE_INSET);
  const bottom = lineStats(image, true, image.height - 1 - EDGE_INSET);
  const left = lineStats(image, false, EDGE_INSET);
  const right = lineStats(image, false, image.width - 1 - EDGE_INSET);
  const pairs = [[top, bottom], [left, right]];
  const framed = pairs.some(([a, b]) => flatColor(a) && flatColor(b) && sameColor(a, b));
  if (!framed) return null;
  return "画面の縁が同じ色で塗られています。動画がフルスクリーンになっていないかもしれません。";
}

function numberIn(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}

export function sanitizeSettings(input) {
  const source = input && typeof input === "object" ? input : {};
  const screen = source.screen || {};
  const aspect = source.videoAspect || {};
  const { min, max } = SCREEN_LIMITS;
  return {
    screen: {
      width: Math.round(numberIn(screen.width, DEFAULT_SETTINGS.screen.width, min, max)),
      height: Math.round(numberIn(screen.height, DEFAULT_SETTINGS.screen.height, min, max)),
    },
    videoAspect: {
      width: numberIn(aspect.width, DEFAULT_SETTINGS.videoAspect.width, 0.01, 10000),
      height: numberIn(aspect.height, DEFAULT_SETTINGS.videoAspect.height, 0.01, 10000),
    },
  };
}
