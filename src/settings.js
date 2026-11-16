import fs from "node:fs/promises";
import path from "node:path";
import { SCREEN_LIMITS, sanitizeSettings } from "../public/frame.js";
import { AppError } from "./errors.js";
import { CONFIG_PATH } from "./paths.js";

function checkSettings(input) {
  const { min, max } = SCREEN_LIMITS;
  const screen = input?.screen || {};
  const aspect = input?.videoAspect || {};
  for (const value of [screen.width, screen.height]) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new AppError(`基準の画面サイズは ${min}〜${max} の整数で指定してください`, 400, "BAD_SETTINGS");
    }
  }
  for (const value of [aspect.width, aspect.height]) {
    if (typeof value !== "number" || !(value > 0) || value > 10000) {
      throw new AppError("動画の縦横比は正の数で指定してください", 400, "BAD_SETTINGS");
    }
  }
}

export class SettingsStore {
  constructor(file = CONFIG_PATH) {
    this.file = file;
  }

  async load() {
    try {
      return sanitizeSettings(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return sanitizeSettings(null);
      throw error;
    }
  }

  async save(input) {
    checkSettings(input);
    const settings = sanitizeSettings(input);
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    return settings;
  }
}
