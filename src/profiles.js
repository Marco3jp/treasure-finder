import { hostFromInput } from "./domain.js";

const ARG_PATTERN = /^--[A-Za-z0-9][A-Za-z0-9._:-]*(=.+)?$/;
const ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

export const CAPTURE_WIDTH = 1920;
export const CAPTURE_HEIGHT = 1080;
export const JPEG_QUALITY = 90;

export const BASE_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--force-device-scale-factor=1",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
];

export const BUILTIN_PROFILES = [
  {
    id: "default",
    label: "標準（ハードウェアアクセラレーション有効）",
    builtin: true,
    args: [],
  },
  {
    id: "no-gpu",
    label: "ソフトウェア描画（ハードウェアアクセラレーション無効）",
    builtin: true,
    args: [
      "--disable-gpu",
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      "--disable-accelerated-mjpeg-decode",
      "--disable-gpu-rasterization",
      "--disable-features=VaapiVideoDecoder,VaapiVideoEncoder,CanvasOopRasterization,AcceleratedVideoDecodeLinuxGL,AcceleratedVideoEncoder",
    ],
  },
  {
    id: "swiftshader",
    label: "SwiftShader（ソフトウェアGL）",
    builtin: true,
    args: [
      "--disable-accelerated-video-decode",
      "--disable-accelerated-video-encode",
      "--use-gl=angle",
      "--use-angle=swiftshader",
    ],
  },
];

export function defaultConfig() {
  return {
    version: 1,
    engine: "auto",
    executablePath: "",
    defaultProfile: "default",
    domainProfiles: {},
    customProfiles: [],
    filenameRules: {
      default: { type: "timestamp" },
      domains: {},
    },
  };
}

export function allProfiles(config) {
  return [...BUILTIN_PROFILES, ...(config.customProfiles || [])];
}

export function getProfile(config, profileId) {
  const found = allProfiles(config).find((profile) => profile.id === profileId);
  if (!found) {
    throw new Error(`起動プロファイル「${profileId}」がありません`);
  }
  return found;
}

export function buildLaunchArgs(profile) {
  const args = [...BASE_ARGS];
  for (const arg of profile.args || []) {
    if (!args.includes(arg)) args.push(arg);
  }
  return args;
}

function cleanArgs(args) {
  if (!Array.isArray(args)) {
    throw new Error("起動引数は配列で指定してください");
  }
  return args.map((arg) => {
    const value = String(arg || "").trim();
    if (!ARG_PATTERN.test(value)) {
      throw new Error(`起動引数として読めません: ${value}`);
    }
    return value;
  });
}

export function sanitizeConfig(input) {
  const base = defaultConfig();
  const source = input && typeof input === "object" ? input : {};
  const engine = ["auto", "chrome", "chromium", "custom"].includes(source.engine)
    ? source.engine
    : "auto";

  const customProfiles = [];
  const seen = new Set(BUILTIN_PROFILES.map((profile) => profile.id));
  for (const raw of source.customProfiles || []) {
    const id = String(raw?.id || "").trim();
    if (!ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error(`プロファイルID「${id}」は使えません`);
    }
    seen.add(id);
    const label = String(raw?.label || id).trim().slice(0, 80);
    customProfiles.push({
      id,
      label: label || id,
      builtin: false,
      args: cleanArgs(raw?.args || []),
    });
  }

  const known = new Set(allProfiles({ customProfiles }).map((profile) => profile.id));
  const defaultProfile = known.has(source.defaultProfile) ? source.defaultProfile : "default";
  const domainProfiles = {};
  const rawDomains = source.domainProfiles && typeof source.domainProfiles === "object"
    ? source.domainProfiles
    : {};
  for (const [host, profileId] of Object.entries(rawDomains)) {
    if (host === "__proto__" || host === "prototype" || host === "constructor") continue;
    const profile = String(profileId || "");
    if (!known.has(profile)) {
      throw new Error(`ドメイン ${host} の起動プロファイルが不明です`);
    }
    domainProfiles[hostFromInput(host)] = profile;
  }

  const filenameDomains = {};
  const rawFilenameDomains = source.filenameRules?.domains;
  if (rawFilenameDomains && typeof rawFilenameDomains === "object") {
    for (const [host, rule] of Object.entries(rawFilenameDomains)) {
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
      if (typeof rule.type !== "string" || !rule.type.trim()) continue;
      filenameDomains[hostFromInput(host)] = { ...rule, type: rule.type.trim() };
    }
  }

  return {
    ...base,
    version: 1,
    engine,
    executablePath: String(source.executablePath || "").trim(),
    defaultProfile,
    domainProfiles,
    customProfiles,
    filenameRules: {
      default: { type: "timestamp" },
      domains: filenameDomains,
    },
  };
}
