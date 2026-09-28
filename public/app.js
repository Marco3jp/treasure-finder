const urlInput = document.querySelector("#url");
const banner = document.querySelector("#banner");
const lamp = document.querySelector("#lamp");
const engineLine = document.querySelector("#engine-line");
const uaLine = document.querySelector("#ua-line");
const domainLine = document.querySelector("#domain-line");
const chromeLine = document.querySelector("#chrome-line");
const rules = document.querySelector("#rules");
const profileSelect = document.querySelector("#rule-profile");
const defaultProfile = document.querySelector("#default-profile");
const catalog = document.querySelector("#profile-catalog");
const filenamePreview = document.querySelector("#filename-preview");
const preview = document.querySelector("#preview");
const stageEmpty = document.querySelector("#stage-empty");
const shotMeta = document.querySelector("#shot-meta");
const filmstrip = document.querySelector("#filmstrip");
const captureButton = document.querySelector("#capture");
const live = document.querySelector("#live");
const liveEmpty = document.querySelector("#live-empty");
const liveStage = document.querySelector("#live-stage");
const liveMeta = document.querySelector("#live-meta");
const liveNote = document.querySelector("#live-note");

let config = null;
let profiles = [];
let busy = false;
let browserOpen = false;
let liveState = null;

// 画面が見えていてブラウザが開いている間だけ、MJPEG を受け取る
function connectLive() {
  const wanted = browserOpen && document.visibilityState === "visible";
  live.hidden = !browserOpen;
  liveEmpty.hidden = browserOpen;
  if (wanted && !live.getAttribute("src")) live.src = `/api/live?t=${Date.now()}`;
  if (!wanted && live.getAttribute("src")) live.removeAttribute("src");
}

// screencast はページ全体なので、撮影対象の video の範囲だけが枠に収まるよう拡大して切り抜く
function placeLive() {
  const viewport = liveState?.viewport;
  if (liveState?.mode !== "page" || !viewport) {
    live.removeAttribute("style");
    return;
  }
  const box = liveState.target || { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const stageWidth = liveStage.clientWidth;
  const stageHeight = liveStage.clientHeight;
  const scale = Math.min(stageWidth / box.width, stageHeight / box.height);
  const left = (stageWidth - box.width * scale) / 2 - box.x * scale;
  const top = (stageHeight - box.height * scale) / 2 - box.y * scale;
  const right = (viewport.width - box.x - box.width) * scale;
  const bottom = (viewport.height - box.y - box.height) * scale;
  Object.assign(live.style, {
    width: `${viewport.width * scale}px`,
    height: `${viewport.height * scale}px`,
    left: `${left}px`,
    top: `${top}px`,
    clipPath: `inset(${box.y * scale}px ${right}px ${bottom}px ${box.x * scale}px)`,
    objectFit: "fill",
  });
}

live.addEventListener("error", () => live.removeAttribute("src"));
document.addEventListener("visibilitychange", connectLive);
window.addEventListener("resize", placeLive);

function showError(message) {
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    return;
  }
  banner.hidden = false;
  banner.textContent = message;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "失敗しました");
  return payload;
}

function fillProfiles(select, selected) {
  select.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.label;
    option.selected = profile.id === selected;
    select.appendChild(option);
  }
}

function renderConfig() {
  if (!config) return;
  for (const input of document.querySelectorAll('input[name="engine"]')) {
    input.checked = input.value === config.engine;
  }
  document.querySelector("#executable-path").value = config.executablePath || "";
  fillProfiles(profileSelect, "no-gpu");
  fillProfiles(defaultProfile, config.defaultProfile);
  filenamePreview.textContent = JSON.stringify(config.filenameRules, null, 2);
  rules.replaceChildren();
  const entries = Object.entries(config.domainProfiles || {});
  if (!entries.length) {
    const item = document.createElement("li");
    item.textContent = "ドメイン指定はまだありません。全部、上の標準起動です。";
    rules.appendChild(item);
  }
  for (const [host, profileId] of entries) {
    const item = document.createElement("li");
    const name = document.createElement("code");
    name.textContent = host;
    const side = document.createElement("div");
    side.className = "cluster";
    const label = document.createElement("span");
    label.textContent = profiles.find((profile) => profile.id === profileId)?.label || profileId;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "外す";
    remove.addEventListener("click", async () => {
      delete config.domainProfiles[host];
      await saveConfig();
    });
    side.append(label, remove);
    item.append(name, side);
    rules.appendChild(item);
  }
  catalog.replaceChildren();
  for (const profile of profiles) {
    const item = document.createElement("li");
    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = profile.label;
    const args = document.createElement("p");
    args.textContent = profile.args?.length ? profile.args.join(" ") : "追加の起動引数はありません";
    text.append(title, args);
    item.append(text);
    if (!profile.builtin) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "削除";
      remove.addEventListener("click", async () => {
        config.customProfiles = config.customProfiles.filter((entry) => entry.id !== profile.id);
        for (const [host, profileId] of Object.entries(config.domainProfiles)) {
          if (profileId === profile.id) delete config.domainProfiles[host];
        }
        if (config.defaultProfile === profile.id) config.defaultProfile = "default";
        await saveConfig();
      });
      item.append(remove);
    }
    catalog.appendChild(item);
  }
}

function renderStatus(status) {
  browserOpen = status.browserOpen;
  connectLive();
  liveState = status.live;
  placeLive();
  const mode = status.live?.mode;
  const fallback = mode === "page";
  liveMeta.textContent = {
    video: "撮影される video の映像",
    loading: "video を読み込んでいます",
    page: status.live?.target ? "ページを video の位置で切り抜き" : "ページ全体",
  }[mode] || "";
  liveNote.hidden = !fallback;
  if (fallback && status.live.target) {
    liveNote.textContent = "video の映像を直接読み出せなかったので、ページの表示を video の位置で切り抜いています。操作ボタンや字幕が重なって見えることがあり、撮影結果とは見た目が違う場合があります。";
  } else if (fallback) {
    liveNote.textContent = "撮影できる video 要素を検出できていません。ページ全体を映しています。動画が再生されているか確認してください。";
  }
  lamp.className = "lamp";
  if (status.capturing) lamp.classList.add("hot");
  else if (status.launching) lamp.classList.add("busy");
  else if (status.browserOpen) lamp.classList.add("on");
  if (status.browserOpen) {
    engineLine.textContent = `${status.engineLabel || status.engine} ${status.version || ""}`.trim();
  } else if (status.launching) {
    engineLine.textContent = "ブラウザを起動しています";
  } else {
    engineLine.textContent = "ブラウザはまだ起動していません";
  }
  uaLine.textContent = status.userAgent || "";
  if (status.domain) {
    domainLine.textContent = `${status.domain} は「${status.profileLabel || status.profileId}」で起動中です`;
  } else {
    domainLine.textContent = "ドメインごとの起動方法は、そのドメインを開いたときに切り替わります。";
  }
  if (status.url && document.activeElement !== urlInput) urlInput.value = status.url;
  if (status.chrome?.path) {
    chromeLine.textContent = "このPCの Google Chrome を、普段のウィンドウとは別のユーザーデータで起動します。";
  } else {
    chromeLine.textContent = "このPCでは Google Chrome が見つかりません。インストールするか、実行ファイルのパスを指定してください。";
  }
  if (status.lastError && !busy) showError(status.lastError);
  captureButton.disabled = busy || !status.browserOpen || status.capturing;
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
  const latest = files[0];
  const selected = files.find((file) => file.name === selectedName);
  if (latest.name !== latestName || !selected) showShot(latest);
  else showShot(selected);
  latestName = latest.name;
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

async function saveConfig() {
  busy = true;
  showError("");
  try {
    const payload = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config }),
    });
    config = payload.config;
    profiles = payload.profiles;
    renderConfig();
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    await refresh();
  }
}

async function refresh() {
  try {
    const [status, shots] = await Promise.all([
      api("/api/status"),
      api("/api/captures"),
    ]);
    renderStatus(status);
    renderCaptures(shots.files);
  } catch (error) {
    if (!busy) showError(error.message);
  }
}

async function loadConfig() {
  const payload = await api("/api/config");
  config = payload.config;
  profiles = payload.profiles;
  renderConfig();
}

document.querySelector("#nav-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  busy = true;
  showError("");
  captureButton.disabled = true;
  try {
    await api("/api/navigate", {
      method: "POST",
      body: JSON.stringify({ url: urlInput.value }),
    });
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    await refresh();
  }
});

document.querySelector("#sample").addEventListener("click", () => {
  urlInput.value = `${location.origin}/sample.html`;
  document.querySelector("#nav-form").requestSubmit();
});

captureButton.addEventListener("click", async () => {
  busy = true;
  showError("");
  captureButton.disabled = true;
  captureButton.textContent = "撮っています";
  try {
    const shot = await api("/api/capture", { method: "POST", body: "{}" });
    shotMeta.textContent = `${shot.file} · ${shot.width}×${shot.height} · ${Math.ceil(shot.bytes / 1024)}KB`;
  } catch (error) {
    showError(error.message);
  } finally {
    captureButton.textContent = "この video を撮る";
    busy = false;
    await refresh();
  }
});

document.querySelector("#engine-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selected = document.querySelector('input[name="engine"]:checked');
  config.engine = selected ? selected.value : "auto";
  config.executablePath = document.querySelector("#executable-path").value.trim();
  await saveConfig();
});

document.querySelector("#rule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const host = document.querySelector("#rule-host").value.trim();
  if (!host) return;
  config.domainProfiles[host] = profileSelect.value;
  document.querySelector("#rule-host").value = "";
  await saveConfig();
});

defaultProfile.addEventListener("change", async () => {
  config.defaultProfile = defaultProfile.value;
  await saveConfig();
});

document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const args = document.querySelector("#profile-args").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  config.customProfiles.push({
    id: document.querySelector("#profile-id").value.trim(),
    label: document.querySelector("#profile-label").value.trim(),
    args,
  });
  document.querySelector("#profile-form").reset();
  await saveConfig();
});

document.querySelector("#open-captures").addEventListener("click", async () => {
  try {
    await api("/api/captures/open", { method: "POST", body: "{}" });
  } catch (error) {
    showError(error.message);
  }
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    captureButton.click();
  }
});

await loadConfig();
await refresh();
setInterval(() => {
  if (!busy) void refresh();
}, 1500);
