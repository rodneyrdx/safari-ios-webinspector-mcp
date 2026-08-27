import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { listTrustedDevices } from "./device-discovery.js";
import { ensureRemoteDebuggerTunnelRegistry } from "./remote-debugger-tunnel.js";
import { execFileText, commandPath } from "../utils/exec.js";
import type { CommandStatus, EnvironmentCheckResult } from "../types.js";

const require = createRequire(import.meta.url);

async function inspectCommand(name: string, versionArgs?: string[]): Promise<CommandStatus> {
  const cmdPath = await commandPath(name);
  if (!cmdPath) {
    return {
      name,
      installed: false,
      notes: [`Install ${name} and retry.`]
    };
  }

  let version: string | undefined;
  if (versionArgs) {
    try {
      const { stdout, stderr } = await execFileText(cmdPath, versionArgs, 3000);
      version = `${stdout}\n${stderr}`.trim().split("\n").find(Boolean);
    } catch {
      version = undefined;
    }
  }

  return {
    name,
    installed: true,
    path: cmdPath,
    version
  };
}

export async function checkEnvironment(): Promise<EnvironmentCheckResult> {
  const commands = await Promise.all([
    inspectCommand("idevice_id", ["-h"]),
    inspectCommand("ideviceinfo", ["-h"]),
    inspectCommand("ios_webkit_debug_proxy", ["--help"]),
    inspectCommand("safaridriver", ["--version"]),
    inspectCommand("xcode-select", ["-p"]),
    inspectCommand("osascript", ["-h"])
  ]);

  let platform = process.platform;
  let macosVersion: string | undefined;
  let xcodeDeveloperPath: string | undefined;

  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileText("sw_vers", [], 2000);
      macosVersion = stdout
        .split("\n")
        .find((line) => line.startsWith("ProductVersion:"))
        ?.split(":")[1]
        ?.trim();
    } catch {
      macosVersion = undefined;
    }
  }

  try {
    const xcodeSelect = commands.find((item) => item.name === "xcode-select");
    if (xcodeSelect?.installed && xcodeSelect.path) {
      const { stdout } = await execFileText(xcodeSelect.path, ["-p"], 2000);
      xcodeDeveloperPath = stdout.trim() || undefined;
    }
  } catch {
    xcodeDeveloperPath = undefined;
  }

  const trustedDevices = await listTrustedDevices().catch(() => []);
  const connectedDevices = trustedDevices.map((device) => device.udid);
  const remoteDebuggerPackagesInstalled = hasPackage("appium-remote-debugger") && hasPackage("appium-ios-remotexpc");
  const requiresTunnelRegistry = trustedDevices.some((device) => requiresRemoteDebuggerTunnel(device.iosVersion));
  const remoteDebuggerTunnel = remoteDebuggerPackagesInstalled
    ? await ensureRemoteDebuggerTunnelRegistry().catch(() => ({ ready: false, seededStrongbox: false }))
    : { ready: false, seededStrongbox: false };

  const recommendations: string[] = [];
  const webdriverCommand = commands.find((item) => item.name === "safaridriver");
  const iwdpCommand = commands.find((item) => item.name === "ios_webkit_debug_proxy");
  const ideviceId = commands.find((item) => item.name === "idevice_id");

  if (platform !== "darwin") {
    recommendations.push("This tool targets macOS only.");
  }
  if (!ideviceId?.installed) {
    recommendations.push("Install libimobiledevice so the bridge can list trusted iPhones.");
  }
  if (!iwdpCommand?.installed) {
    recommendations.push("Install ios-webkit-debug-proxy to expose iPhone Web Inspector pages over localhost.");
  }
  if (!webdriverCommand?.installed) {
    recommendations.push("Install or expose safaridriver to launch isolated Safari WebDriver sessions on the iPhone.");
  } else {
    recommendations.push("Run `safaridriver --enable` once on this Mac if Safari Remote Automation has not been enabled yet.");
    recommendations.push("On the iPhone, enable Settings > Safari > Advanced > Remote Automation before launching managed sessions.");
    recommendations.push("Keep the iPhone unlocked when creating a new managed Safari session.");
  }
  if (connectedDevices.length === 0) {
    recommendations.push("Connect and trust at least one iPhone before using live-device tools.");
  }
  if (remoteDebuggerPackagesInstalled && requiresTunnelRegistry && !remoteDebuggerTunnel.ready) {
    recommendations.push(
      "Start the appium-ios-remotexpc tunnel registry before using existing-tab attach on iOS 18+ devices."
    );
    recommendations.push(
      "Recommended command: `sudo node node_modules/appium-ios-remotexpc/scripts/tunnel-creation.mjs --udid <DEVICE_UDID> --keep-open`."
    );
  }
  recommendations.push("This server intentionally stays browser-only: no device reset, restore, or non-Safari system automation.");

  return {
    platform,
    macosVersion,
    xcodeDeveloperPath,
    commands,
    connectedDevices,
    safariInstalled: process.platform === "darwin",
    transportReadiness: {
      iwdpEvidence: Boolean(iwdpCommand?.installed && connectedDevices.length > 0),
      webdriver: Boolean(webdriverCommand?.installed && connectedDevices.length > 0),
      remoteDebugger: remoteDebuggerPackagesInstalled && (!requiresTunnelRegistry || remoteDebuggerTunnel.ready),
      iphoneMirroring: await hasIphoneMirroring()
    },
    safeMode: {
      browserOnly: true,
      forbiddenOperations: [
        "device reset or restore",
        "pairing record mutation",
        "system settings automation outside Safari prerequisites",
        "firmware, recovery, or DFU actions"
      ]
    },
    recommendations
  };
}

function hasPackage(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return existsSync(path.join(process.cwd(), "node_modules", name, "package.json"));
  }
}

async function hasIphoneMirroring(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    await fs.access("/System/Applications/iPhone Mirroring.app");
    return true;
  } catch {
    return false;
  }
}

function requiresRemoteDebuggerTunnel(iosVersion?: string): boolean {
  const major = Number.parseInt(String(iosVersion ?? "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 18;
}
