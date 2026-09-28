import { accessSync, constants } from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";

function canExecute(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findSystemChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    for (const root of roots) {
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    candidates.push(
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/usr/local/bin/google-chrome",
    );
  }
  return candidates.find((candidate) => candidate && canExecute(candidate)) || null;
}

function chromeEngine(chromePath) {
  return {
    key: "chrome",
    label: "Google Chrome",
    executablePath: chromePath,
    overrideUa: false,
  };
}

export async function resolveEngine(config) {
  const chromePath = findSystemChrome();
  if (config.engine === "custom") {
    if (!config.executablePath) {
      throw new AppError("実行ファイルのパスを入れてください", 400, "NO_ENGINE");
    }
    return {
      key: "custom",
      label: "指定した実行ファイル",
      executablePath: config.executablePath,
      overrideUa: true,
    };
  }
  if (config.engine === "chrome" || config.engine === "auto" || config.engine === "chromium" || !config.engine) {
    if (!chromePath) {
      throw new AppError(
        "Google Chrome が見つかりません。インストールするか、実行ファイルのパスを指定してください。",
        400,
        "NO_CHROME",
      );
    }
    return chromeEngine(chromePath);
  }
  if (chromePath) return chromeEngine(chromePath);
  throw new AppError(
    "Google Chrome が見つかりません。インストールするか、実行ファイルのパスを指定してください。",
    400,
    "NO_CHROME",
  );
}

export function explainLaunchError(error) {
  if (error instanceof AppError) return error;
  return new AppError(String(error?.message || error), 500, "LAUNCH_FAILED");
}
