import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, sanitizeConfig } from "./profiles.js";

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
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const CAPTURES_DIR = path.join(DATA_DIR, "captures");
export const USER_DATA_ROOT = path.join(DATA_DIR, "user-data");
export const PUBLIC_DIR = publicDir();

export class ConfigStore {
  constructor(file = CONFIG_PATH) {
    this.file = file;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      return sanitizeConfig(JSON.parse(raw));
    } catch (error) {
      if (error && error.code === "ENOENT") return defaultConfig();
      if (error instanceof SyntaxError) return defaultConfig();
      throw error;
    }
  }

  async save(input) {
    const config = sanitizeConfig(input);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
}
