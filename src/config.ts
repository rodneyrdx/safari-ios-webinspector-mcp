import os from "node:os";
import path from "node:path";

export interface AppConfig {
  cacheDir: string;
  bundleDir: string;
  bridgeCommand: string;
  bridgeArgs: string[];
  bridgeHost: string;
  deviceListPort: number;
  firstDevicePort: number;
  wsRequestTimeoutMs: number;
  uiAutomationTimeoutMs: number;
  webDriverCommand: string;
  webDriverPort: number;
}

export function getConfig(): AppConfig {
  const cacheRoot = process.env.SAFARI_IOS_WEBINSPECTOR_CACHE_DIR
    ?? path.join(os.homedir(), ".cache", "safari-ios-webinspector");

  const bridgeCommand = process.env.SAFARI_IOS_WEBINSPECTOR_BRIDGE_COMMAND ?? "ios_webkit_debug_proxy";
  const bridgeArgs = (process.env.SAFARI_IOS_WEBINSPECTOR_BRIDGE_ARGS ?? "")
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    cacheDir: cacheRoot,
    bundleDir: path.join(cacheRoot, "bundles"),
    bridgeCommand,
    bridgeArgs,
    bridgeHost: process.env.SAFARI_IOS_WEBINSPECTOR_BRIDGE_HOST ?? "127.0.0.1",
    deviceListPort: Number(process.env.SAFARI_IOS_WEBINSPECTOR_DEVICE_LIST_PORT ?? "9221"),
    firstDevicePort: Number(process.env.SAFARI_IOS_WEBINSPECTOR_FIRST_DEVICE_PORT ?? "9222"),
    wsRequestTimeoutMs: Number(process.env.SAFARI_IOS_WEBINSPECTOR_WS_TIMEOUT_MS ?? "5000"),
    uiAutomationTimeoutMs: Number(process.env.SAFARI_IOS_WEBINSPECTOR_UI_TIMEOUT_MS ?? "4000"),
    webDriverCommand: process.env.SAFARI_IOS_WEBINSPECTOR_WEBDRIVER_COMMAND ?? "safaridriver",
    webDriverPort: Number(process.env.SAFARI_IOS_WEBINSPECTOR_WEBDRIVER_PORT ?? "4445")
  };
}
