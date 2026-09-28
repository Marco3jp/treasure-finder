import { AppError } from "./errors.js";

const LABELED_HOST = /^[a-z0-9.-]+$/;

export function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export function hostFromInput(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new AppError("ドメインが空です", 400, "BAD_HOST");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname;
  try {
    hostname = new URL(withScheme).hostname;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("ドメインとして読めません", 400, "BAD_HOST");
  }
  hostname = normalizeHost(hostname);
  if (!hostname || !LABELED_HOST.test(hostname)) {
    throw new AppError("example.com の形で指定してください", 400, "BAD_HOST");
  }
  return hostname;
}

export function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    throw new AppError("URLが空です", 400, "BAD_URL");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("URLとして読めません", 400, "BAD_URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("http と https だけ開けます", 400, "BAD_URL");
  }
  return url.toString();
}

export function matchHostRule(hostname, rules) {
  if (!rules) return undefined;
  const host = normalizeHost(hostname);
  if (!host) return undefined;
  if (Object.prototype.hasOwnProperty.call(rules, host)) return rules[host];
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i += 1) {
    const parent = labels.slice(i).join(".");
    if (Object.prototype.hasOwnProperty.call(rules, parent)) return rules[parent];
  }
  return undefined;
}

export function resolveProfileId(hostname, domainProfiles, defaultProfile) {
  return matchHostRule(hostname, domainProfiles) || defaultProfile;
}
