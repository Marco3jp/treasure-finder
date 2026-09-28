import os from "node:os";

export function browserVersionNumber(version) {
  return String(version || "").replace(/^Chrome\//i, "").trim();
}

export function desktopPlatformToken() {
  if (os.platform() === "win32") return "Windows NT 10.0; Win64; x64";
  if (os.platform() === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

export function buildDesktopChromeUA(version) {
  const ver = browserVersionNumber(version);
  return `Mozilla/5.0 (${desktopPlatformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`;
}

export function userAgentOverride(version, acceptLanguage) {
  const ver = browserVersionNumber(version);
  const major = ver.split(".")[0] || "0";
  const platform = os.platform();
  const chPlatform = platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";
  const navPlatform = platform === "win32" ? "Win32" : platform === "darwin" ? "MacIntel" : "Linux x86_64";
  const platformVersion = platform === "win32" ? "15.0.0" : platform === "darwin" ? "15.0.0" : "6.0.0";
  return {
    userAgent: buildDesktopChromeUA(ver),
    acceptLanguage,
    platform: navPlatform,
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major },
        { brand: "Not)A;Brand", version: "24" },
      ],
      fullVersionList: [
        { brand: "Chromium", version: ver },
        { brand: "Google Chrome", version: ver },
        { brand: "Not)A;Brand", version: "24.0.0.0" },
      ],
      fullVersion: ver,
      platform: chPlatform,
      platformVersion,
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  };
}
