import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, sanitizeConfig } from "./profiles.js";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(SRC_DIR, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const CAPTURES_DIR = path.join(DATA_DIR, "captures");
export const USER_DATA_ROOT = path.join(DATA_DIR, "user-data");
export const PUBLIC_DIR = path.join(ROOT_DIR, "public");

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
