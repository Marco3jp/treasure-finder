import {
  DEFAULT_SETTINGS,
  JPEG_QUALITY,
  captureCap,
  containRect,
  edgeWarning,
  outputSize,
  placeVideo,
  ratio,
} from "/frame.js";

const banner = document.querySelector("#banner");
const warning = document.querySelector("#warning");
const lamp = document.querySelector("#lamp");
const shareLine = document.querySelector("#share-line");
const sizeLine = document.querySelector("#size-line");
const shareButton = document.querySelector("#share");
const stopButton = document.querySelector("#stop");
const pipButton = document.querySelector("#pip");
const captureButton = document.querySelector("#capture");
const live = document.querySelector("#live");
const liveEmpty = document.querySelector("#live-empty");
const liveStage = document.querySelector("#live-stage");
const liveMeta = document.querySelector("#live-meta");
const preview = document.querySelector("#preview");
const stageEmpty = document.querySelector("#stage-empty");
const shotMeta = document.querySelector("#shot-meta");
const filmstrip = document.querySelector("#filmstrip");
const capturesDir = document.querySelector("#captures-dir");
const outputTag = document.querySelector("#output-tag");
const settingsForm = document.querySelector("#settings-form");
const screenWidth = document.querySelector("#screen-width");
const screenHeight = document.querySelector("#screen-height");
const outputLine = document.querySelector("#output-line");
const aspectPreset = document.querySelector("#aspect-preset");
const aspectWidth = document.querySelector("#aspect-width");
const aspectHeight = document.querySelector("#aspect-height");
const settingsNote = document.querySelector("#settings-note");

const SAMPLE_WIDTH = 384;
const PREVIEW_MS = 100;

let settings = DEFAULT_SETTINGS;
let track = null;
let latest = null;
let capKey = null;
let capturing = false;
let lastDrawn = 0;
let pipWindow = null;

const canShare = Boolean(navigator.mediaDevices?.getDisplayMedia) && "MediaStreamTrackProcessor" in window;

function showError(message) {
  banner.hidden = !message;
  banner.textContent = message || "";
}

function showWarnings(messages) {
  warning.hidden = !messages.length;
  warning.textContent = messages.join(" ");
}

async function api(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "失敗しました");
  return payload;
}

function render() {
  const sharing = Boolean(track);
  const ready = sharing && Boolean(latest) && !capturing;
  lamp.className = "status-dot";
  if (capturing) lamp.classList.add("is-busy");
  else if (sharing) lamp.classList.add("is-on");
  shareButton.textContent = sharing ? "別のタブを選ぶ" : "撮るタブを選ぶ";
  shareButton.disabled = !canShare;
  stopButton.hidden = !sharing;
  pipButton.hidden = !sharing || !("documentPictureInPicture" in window);
  captureButton.disabled = !ready;
  captureButton.textContent = capturing ? "撮っています" : "このフレームを撮る";
  live.hidden = !sharing;
  liveEmpty.hidden = sharing;
  if (!canShare) {
    shareLine.textContent = "このブラウザではタブを取り込めません。Google Chrome か Microsoft Edge で開いてください。";
  } else if (!sharing) {
    shareLine.textContent = "まだタブを共有していません";
  } else {
    shareLine.textContent = track.getSettings().displaySurface === "browser"
      ? "タブを共有しています"
      : "画面かウィンドウを共有しています。タブを選ぶと、動画の部分だけが写ります。";
  }
  const width = latest?.displayWidth;
  const height = latest?.displayHeight;
  sizeLine.textContent = width ? `取り込み ${width}×${height}` : "";
  liveMeta.textContent = width && placeVideo({ width, height }, settings).scale > 1.01
    ? "動画の範囲が保存サイズより小さいので、引き伸ばして保存します"
    : width ? "点線の中を保存します" : "";
  const output = outputSize(settings);
  outputTag.textContent = `${output.width}×${output.height} · JPEG ${JPEG_QUALITY}`;
  if (pipWindow) {
    const button = pipWindow.document.querySelector("#capture");
    if (button) {
      button.disabled = !ready;
      button.textContent = captureButton.textContent;
    }
  }
}

function drawPreview(frame) {
  const now = performance.now();
  if (document.visibilityState !== "visible" || now - lastDrawn < PREVIEW_MS) return;
  lastDrawn = now;
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(liveStage.clientWidth * scale);
  const height = Math.round(liveStage.clientHeight * scale);
  if (!width || !height) return;
  if (live.width !== width || live.height !== height) {
    live.width = width;
    live.height = height;
  }
  const context = live.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);
  const size = { width: frame.displayWidth, height: frame.displayHeight };
  const place = containRect({ width, height }, ratio(size));
  context.drawImage(frame, place.x, place.y, place.width, place.height);
  const { source } = placeVideo(size, settings);
  const shrink = place.width / size.width;
  context.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio]);
  context.lineWidth = Math.max(1, devicePixelRatio);
  context.strokeStyle = "#1677ff";
  context.strokeRect(
    place.x + source.x * shrink + 0.5,
    place.y + source.y * shrink + 0.5,
    source.width * shrink - 1,
    source.height * shrink - 1,
  );
}

// 画面の縦横比（フルスクリーンにした、など）か設定が変わったら、取り込みの上限を合わせ直す
async function fitCap(target, frame) {
  const aspect = frame.displayWidth / frame.displayHeight;
  const key = `${aspect.toFixed(3)}:${JSON.stringify(settings)}`;
  if (key === capKey) return;
  capKey = key;
  const cap = captureCap(aspect, settings);
  await target.applyConstraints({
    width: { max: cap.width },
    height: { max: cap.height },
    frameRate: { max: 30 },
  }).catch(() => {});
}

// 撮るときに待たなくていいように、届いたフレームのうち最新の1枚を持っておく
async function readFrames(target) {
  const reader = new MediaStreamTrackProcessor({ track: target }).readable.getReader();
  try {
    while (track === target) {
      const { value, done } = await reader.read();
      if (done) break;
      if (track !== target) {
        value.close();
        break;
      }
      const resized = latest?.displayWidth !== value.displayWidth || latest?.displayHeight !== value.displayHeight;
      latest?.close();
      latest = value;
      drawPreview(value);
      void fitCap(target, value);
      if (resized) render();
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function releaseTrack() {
  const current = track;
  track = null;
  capKey = null;
  latest?.close();
  latest = null;
  current?.stop();
}

function stopShare() {
  releaseTrack();
  pipWindow?.close();
  render();
}

async function startShare() {
  showError("");
  const controller = "CaptureController" in window ? new CaptureController() : undefined;
  // フルスクリーンにする画面は、たいていこのパネルと同じモニターにある
  const cap = captureCap(screen.width / screen.height, settings);
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
        width: { max: cap.width },
        height: { max: cap.height },
        frameRate: { max: 30 },
      },
      audio: false,
      controller,
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
    });
  } catch (error) {
    if (error.name !== "NotAllowedError") showError(`タブを取り込めませんでした: ${error.message}`);
    return;
  }
  // 選んだら動画のタブへ移る。フルスクリーンにするのはそちらのタブなので
  try {
    controller?.setFocusBehavior("focus-captured-surface");
  } catch {
    // タブ以外を選んだときは切り替えられない
  }
  releaseTrack();
  const next = stream.getVideoTracks()[0];
  next.contentHint = "detail";
  next.addEventListener("ended", () => {
    if (track === next) stopShare();
  });
  track = next;
  render();
  void readFrames(next);
}

function sampleFrame(frame) {
  const width = SAMPLE_WIDTH;
  const height = Math.max(2, Math.round(SAMPLE_WIDTH * frame.displayHeight / frame.displayWidth));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(frame, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
}

async function encodeFrame(frame) {
  const output = outputSize(settings);
  const { source, target, scale } = placeVideo({ width: frame.displayWidth, height: frame.displayHeight }, settings);
  const canvas = new OffscreenCanvas(output.width, output.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#000";
  context.fillRect(0, 0, output.width, output.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(
    frame,
    source.x, source.y, source.width, source.height,
    target.x, target.y, target.width, target.height,
  );
  const warnings = [];
  const edge = edgeWarning(sampleFrame(frame));
  if (edge) warnings.push(edge);
  if (scale > 1.01) {
    warnings.push(`動画の範囲が ${Math.round(source.width)}×${Math.round(source.height)} しかないので、引き伸ばして保存しました。`);
  }
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY / 100 });
  return { blob, warnings };
}

async function capture() {
  if (!latest || capturing) return;
  capturing = true;
  showError("");
  render();
  const frame = latest.clone();
  try {
    const { blob, warnings } = await encodeFrame(frame);
    const shot = await api("/api/captures", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: blob,
    });
    showWarnings(warnings);
    await refreshCaptures();
    shotMeta.textContent = `${shot.file} · ${shot.width}×${shot.height} · ${Math.ceil(shot.bytes / 1024)}KB`;
  } catch (error) {
    showError(error.message);
  } finally {
    frame.close();
    capturing = false;
    render();
  }
}

// 動画をフルスクリーンにしている間も押せるように、撮影ボタンだけを最前面のウィンドウに置く
async function openPip() {
  if (pipWindow) {
    pipWindow.focus();
    return;
  }
  const opened = await documentPictureInPicture.requestWindow({ width: 260, height: 110 });
  const link = opened.document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("/styles.css", location.href).href;
  opened.document.head.append(link);
  opened.document.body.className = "pip";
  const button = opened.document.createElement("button");
  button.type = "button";
  button.id = "capture";
  button.className = "btn btn-primary";
  button.addEventListener("click", () => void capture());
  opened.document.body.append(button);
  opened.document.addEventListener("keydown", onShortcut);
  opened.addEventListener("pagehide", () => {
    if (pipWindow === opened) pipWindow = null;
  });
  pipWindow = opened;
  render();
}

// 一覧は定期的に読み直すので、選んだカットは新しく撮るまで保つ
let shownFiles = "";
let latestName = null;
let selectedName = null;

function showShot(file) {
  selectedName = file.name;
  preview.hidden = false;
  stageEmpty.hidden = true;
  preview.src = `/captures/${file.name}?t=${file.mtimeMs}`;
  preview.alt = file.name;
  shotMeta.textContent = file.name;
}

function renderCaptures(files) {
  const key = (files || []).map((file) => `${file.name}:${file.mtimeMs}`).join("|");
  if (key === shownFiles) return;
  shownFiles = key;
  filmstrip.replaceChildren();
  if (!files?.length) {
    latestName = null;
    selectedName = null;
    preview.hidden = true;
    preview.removeAttribute("src");
    stageEmpty.hidden = false;
    shotMeta.textContent = "";
    return;
  }
  const latestFile = files[0];
  const selected = files.find((file) => file.name === selectedName);
  if (latestFile.name !== latestName || !selected) showShot(latestFile);
  else showShot(selected);
  latestName = latestFile.name;
  for (const file of files) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    const image = document.createElement("img");
    image.src = `/captures/${file.name}?t=${file.mtimeMs}`;
    image.alt = file.name;
    button.append(image);
    button.addEventListener("click", () => showShot(file));
    item.append(button);
    filmstrip.appendChild(item);
  }
}

async function refreshCaptures() {
  try {
    const shots = await api("/api/captures");
    renderCaptures(shots.files);
    capturesDir.textContent = `保存先: ${shots.directory}`;
  } catch (error) {
    showError(error.message);
  }
}

function onShortcut(event) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void capture();
  }
}

const ASPECT_PRESETS = {
  "16:9": [16, 9],
  "4:3": [4, 3],
  "2.39:1": [2.39, 1],
  "1.85:1": [1.85, 1],
};

function renderSettings() {
  screenWidth.value = settings.screen.width;
  screenHeight.value = settings.screen.height;
  const { width, height } = settings.videoAspect;
  const preset = Object.entries(ASPECT_PRESETS).find(([, [w, h]]) => w / h === width / height);
  aspectPreset.value = preset ? preset[0] : "custom";
  aspectWidth.value = width;
  aspectHeight.value = height;
  aspectWidth.disabled = aspectHeight.disabled = Boolean(preset);
  renderOutputLine();
  render();
}

// 入力中の値で、保存されるサイズを先に見せる
function formSettings() {
  return {
    screen: { width: Number(screenWidth.value), height: Number(screenHeight.value) },
    videoAspect: { width: Number(aspectWidth.value), height: Number(aspectHeight.value) },
  };
}

function renderOutputLine() {
  const draft = formSettings();
  const valid = [draft.screen.width, draft.screen.height, draft.videoAspect.width, draft.videoAspect.height]
    .every((value) => value > 0);
  if (!valid) {
    outputLine.textContent = "—";
    return;
  }
  const output = outputSize(draft);
  outputLine.textContent = `${output.width}×${output.height}`;
}

settingsForm.addEventListener("input", renderOutputLine);

aspectPreset.addEventListener("change", () => {
  const preset = ASPECT_PRESETS[aspectPreset.value];
  aspectWidth.disabled = aspectHeight.disabled = Boolean(preset);
  if (preset) [aspectWidth.value, aspectHeight.value] = preset;
  renderOutputLine();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  try {
    settings = await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formSettings()),
    });
    settingsNote.textContent = "保存しました";
    setTimeout(() => { settingsNote.textContent = ""; }, 2000);
    renderSettings();
    if (track && latest) void fitCap(track, latest);
  } catch (error) {
    showError(error.message);
  }
});

shareButton.addEventListener("click", () => void startShare());
stopButton.addEventListener("click", stopShare);
captureButton.addEventListener("click", () => void capture());
pipButton.addEventListener("click", () => {
  openPip().catch((error) => showError(`撮影ボタンのウィンドウを開けませんでした: ${error.message}`));
});
document.addEventListener("keydown", onShortcut);

document.querySelector("#sample").addEventListener("click", () => {
  window.open("/sample.html", "_blank");
});

document.querySelector("#open-captures").addEventListener("click", async () => {
  try {
    await api("/api/captures/open", { method: "POST" });
  } catch (error) {
    showError(error.message);
  }
});

try {
  settings = await api("/api/settings");
} catch (error) {
  showError(error.message);
}
renderSettings();
await refreshCaptures();
setInterval(() => {
  if (!capturing) void refreshCaptures();
}, 3000);
