import { matchHostRule } from "./domain.js";

const strategies = new Map();

export function registerFilenameStrategy(type, build) {
  strategies.set(type, build);
}

export function timestampFilename(date = new Date()) {
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    "-",
    pad(date.getMilliseconds(), 3),
    ".jpg",
  ].join("");
}

registerFilenameStrategy("timestamp", ({ now }) => timestampFilename(now));

export async function buildFilename({ config, page, hostname, now = new Date() }) {
  const domains = config?.filenameRules?.domains || {};
  const rule = matchHostRule(hostname, domains) || config?.filenameRules?.default || { type: "timestamp" };
  const strategy = strategies.get(rule.type) || strategies.get("timestamp");
  const filename = await strategy({ page, rule, hostname, now, config });
  return {
    filename,
    strategy: strategy === strategies.get(rule.type) ? rule.type : "timestamp",
  };
}
