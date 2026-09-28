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
    throw new Error("ドメインが空です");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let hostname;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    throw new Error("ドメインとして読めません");
  }
  hostname = normalizeHost(hostname);
  if (!hostname || !hostname.includes(".") || !LABELED_HOST.test(hostname)) {
    throw new Error("example.com の形で指定してください");
  }
  return hostname;
}

export function normalizeUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) {
    throw new Error("URLが空です");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("URLとして読めません");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("http と https だけ開けます");
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
