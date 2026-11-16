import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function moduleDir() {
  if (typeof import.meta.dirname === "string") return import.meta.dirname;
  if (typeof import.meta.dir === "string") return import.meta.dir;
  return path.dirname(fileURLToPath(import.meta.url));
}

export function isStandalone() {
  return typeof globalThis.Bun !== "undefined" && Boolean(globalThis.Bun.isStandaloneExecutable);
}

function appHome() {
  if (process.env.TREASURE_FINDER_HOME) return path.resolve(process.env.TREASURE_FINDER_HOME);
  if (isStandalone()) return path.dirname(process.execPath);
  return path.resolve(moduleDir(), "..");
}

function publicDir() {
  if (isStandalone()) {
    const embedded = path.join(import.meta.dir || moduleDir(), "public");
    if (existsSync(path.join(embedded, "index.html"))) return embedded;
  }
  return path.resolve(moduleDir(), "../public");
}

export const ROOT_DIR = appHome();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CAPTURES_DIR = path.join(DATA_DIR, "captures");
export const PUBLIC_DIR = publicDir();
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
