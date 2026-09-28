import { AppError } from "./errors.js";
import { jpegSize } from "./jpeg.js";
import { CAPTURE_HEIGHT, CAPTURE_WIDTH, JPEG_QUALITY } from "./profiles.js";

const METRICS = { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT };

function applyCaptureBox(element, metrics) {
  const visited = [];
  let current = element;
  while (current) {
    visited.push(current);
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode?.();
    current = root && root.host ? root.host : null;
  }
  for (const node of visited) {
    if (node.getAttribute("data-koma-marked") === "1") continue;
    node.setAttribute("data-koma-style", node.getAttribute("style") ?? "");
    node.setAttribute("data-koma-marked", "1");
    node.style.setProperty("transform", "none", "important");
    node.style.setProperty("filter", "none", "important");
    node.style.setProperty("perspective", "none", "important");
    node.style.setProperty("contain", "none", "important");
    node.style.setProperty("will-change", "auto", "important");
    if (node !== element) node.style.setProperty("overflow", "visible", "important");
  }
  if (element instanceof HTMLVideoElement) {
    element.setAttribute("data-koma-controls", element.controls ? "1" : "0");
    element.controls = false;
  }
  const entries = {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${metrics.width}px`,
    height: `${metrics.height}px`,
    margin: "0",
    padding: "0",
    border: "0",
    outline: "none",
    transform: "none",
    "object-fit": "contain",
    "object-position": "center center",
    background: "#000",
    "z-index": "2147483647",
    "max-width": "none",
    "max-height": "none",
    "min-width": "0",
    "min-height": "0",
    "box-sizing": "border-box",
    display: "block",
    overflow: "hidden",
  };
  for (const [key, value] of Object.entries(entries)) {
    element.style.setProperty(key, value, "important");
  }
}

function restoreMarked(node) {
  const previous = node.getAttribute("data-koma-style");
  if (previous) node.setAttribute("style", previous);
  else node.removeAttribute("style");
  if (node instanceof HTMLVideoElement && node.hasAttribute("data-koma-controls")) {
    node.controls = node.getAttribute("data-koma-controls") === "1";
  }
  node.removeAttribute("data-koma-style");
  node.removeAttribute("data-koma-marked");
  node.removeAttribute("data-koma-controls");
}

function revertCaptureBox(element) {
  const root = element.ownerDocument;
  if (!root) return;
  const seen = new Set();
  const visit = (scope) => {
    if (!scope?.querySelectorAll || seen.has(scope)) return;
    seen.add(scope);
    for (const node of [...scope.querySelectorAll("[data-koma-marked='1']")]) {
      if (node.shadowRoot) visit(node.shadowRoot);
      restoreMarked(node);
    }
    for (const node of scope.querySelectorAll("*")) {
      if (node.shadowRoot) visit(node.shadowRoot);
    }
  };
  visit(root);
}

async function findBestVideo(page) {
  let best = null;
  let bestScore = -1;
  for (const frame of page.frames()) {
    let count = 0;
    try {
      count = await frame.locator("video").count();
    } catch {
      continue;
    }
    for (let index = 0; index < count; index += 1) {
      const locator = frame.locator("video").nth(index);
      let info;
      try {
        info = await locator.evaluate((video) => {
          const rect = video.getBoundingClientRect();
          const style = getComputedStyle(video);
          const shown = style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity || "1") > 0
            && rect.width > 8
            && rect.height > 8;
          return {
            shown,
            area: (video.videoWidth * video.videoHeight) || (rect.width * rect.height),
            playing: !video.paused && video.readyState >= 2,
            ready: video.readyState >= 2 || video.videoWidth > 0,
          };
        });
      } catch {
        continue;
      }
      if (!info?.shown || !info.ready) continue;
      const score = info.area + (info.playing ? 1_000_000_000_000 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { locator, frame };
      }
    }
  }
  return best;
}

async function expandFrameChain(frame) {
  const chain = [];
  let current = frame;
  while (current.parentFrame()) {
    const element = await current.frameElement().catch(() => null);
    if (!element) break;
    chain.push(element);
    current = current.parentFrame();
  }
  chain.reverse();
  for (const element of chain) {
    await element.evaluate(applyCaptureBox, METRICS);
  }
  return chain;
}

async function restoreFrameChain(chain, locator) {
  if (locator) await locator.evaluate(revertCaptureBox).catch(() => {});
  for (const element of [...chain].reverse()) {
    await element.evaluate(revertCaptureBox).catch(() => {});
  }
}

async function waitForPresentedFrame(locator) {
  await locator.evaluate((video) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => finish());
    }
    requestAnimationFrame(() => requestAnimationFrame(() => finish()));
    setTimeout(finish, 700);
  }));
}

async function screenshotElement(locator) {
  return locator.screenshot({
    type: "jpeg",
    quality: JPEG_QUALITY,
    animations: "disabled",
    scale: "css",
    timeout: 15000,
  });
}

async function screenshotClip(page, box) {
  const client = await page.context().newCDPSession(page);
  try {
    const result = await client.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: JPEG_QUALITY,
      fromSurface: true,
      captureBeyondViewport: true,
      clip: {
        x: box.x,
        y: box.y,
        width: CAPTURE_WIDTH,
        height: CAPTURE_HEIGHT,
        scale: 1,
      },
    });
    return Buffer.from(result.data, "base64");
  } finally {
    await client.detach().catch(() => {});
  }
}

function isExactFrame(buffer) {
  try {
    const size = jpegSize(buffer);
    return size.width === CAPTURE_WIDTH && size.height === CAPTURE_HEIGHT;
  } catch {
    return false;
  }
}

async function waitForBestVideo(page) {
  const deadline = Date.now() + 4000;
  let video = await findBestVideo(page);
  while (!video && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    video = await findBestVideo(page);
  }
  return video;
}

export async function captureVideoFrame(page) {
  const video = await waitForBestVideo(page);
  if (!video) {
    throw new AppError("表示中の video 要素が見つかりません", 422, "NO_VIDEO");
  }
  const chain = [];
  try {
    const frames = await expandFrameChain(video.frame);
    chain.push(...frames);
    await video.locator.evaluate(applyCaptureBox, METRICS);
    await waitForPresentedFrame(video.locator);
    let buffer = await screenshotElement(video.locator);
    if (!isExactFrame(buffer)) {
      const box = await video.locator.boundingBox();
      if (box) buffer = await screenshotClip(page, box);
    }
    if (!isExactFrame(buffer)) {
      const size = jpegSize(buffer);
      throw new AppError(
        `1920×1080 で撮れませんでした（${size.width}×${size.height}）`,
        500,
        "BAD_SIZE",
      );
    }
    return buffer;
  } finally {
    await restoreFrameChain(chain, video.locator);
  }
}
