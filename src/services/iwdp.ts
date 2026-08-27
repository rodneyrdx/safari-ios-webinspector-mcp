import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError } from "../errors.js";
import type { AppConfig } from "../config.js";
import type { BridgeStatus, DeviceInfo, PageInfo, ParsedDevicePort, ParsedPageDescriptor } from "../types.js";
import { listTrustedDevices, matchTrustedDevice } from "./device-discovery.js";
import { ensureDir } from "../utils/fs.js";
import { commandPath } from "../utils/exec.js";

interface BridgeProcessState {
  process?: ChildProcessWithoutNullStreams;
  startedAt?: string;
  logs: string[];
  externalRunning?: boolean;
}

export class IwdpManager {
  private readonly state: BridgeProcessState = { logs: [] };

  constructor(private readonly config: AppConfig) {}

  getStatus(): BridgeStatus {
    return {
      running: Boolean(this.state.externalRunning || (this.state.process && !this.state.process.killed)),
      pid: this.state.process?.pid,
      startedAt: this.state.startedAt,
      basePort: this.config.firstDevicePort,
      deviceListPort: this.config.deviceListPort,
      notes: [
        "This bridge expects ios_webkit_debug_proxy to expose the device list on port 9221 and device tabs on 9222+.",
        ...(this.state.externalRunning
          ? ["Bridge health is currently being served by an external ios_webkit_debug_proxy process."]
          : [])
      ],
      recentLogs: this.state.logs.slice(-40)
    };
  }

  async ensureStarted(): Promise<BridgeStatus> {
    if (!this.state.process) {
      try {
        if (await this.isHealthy()) {
          this.state.externalRunning = true;
          return this.getStatus();
        }
      } catch {
        this.state.externalRunning = false;
      }
    }

    if (this.state.process && !this.state.process.killed) {
      this.state.externalRunning = false;
      return this.getStatus();
    }

    const command = await commandPath(this.config.bridgeCommand);
    if (!command) {
      throw new ToolError("dependency_missing", "ios_webkit_debug_proxy is not installed.");
    }

    await ensureDir(this.config.cacheDir);

    const child = spawn(command, this.config.bridgeArgs, {
      env: process.env,
      stdio: "pipe"
    });

    this.state.process = child;
    this.state.startedAt = new Date().toISOString();

    child.stdout.on("data", (chunk) => this.pushLog(String(chunk)));
    child.stderr.on("data", (chunk) => this.pushLog(String(chunk)));
    child.on("exit", (code, signal) => {
      this.pushLog(`bridge exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.state.process = undefined;
      this.state.externalRunning = false;
    });

    await this.waitForHealth();
    this.state.externalRunning = false;
    return this.getStatus();
  }

  async stop(): Promise<BridgeStatus> {
    if (this.state.process && !this.state.process.killed) {
      this.state.process.kill("SIGTERM");
      await delay(250);
    }
    if (this.state.process?.killed) {
      this.state.externalRunning = false;
    }
    return this.getStatus();
  }

  async listDevices(): Promise<DeviceInfo[]> {
    await this.ensureStarted();
    const devices = await fetchDevicesFromBridge(this.config.deviceListPort);
    const trustedDevices = await listTrustedDevices();
    return devices.map((device) => {
      const trusted = matchTrustedDevice(device.displayName, trustedDevices);
      return {
      deviceId: `ios-${device.port}`,
      displayName: device.displayName,
      port: device.port,
      browserFamily: "webkit" as const,
      physicalId: trusted?.udid,
      iosVersion: trusted?.iosVersion,
      inspectable: true
      };
    });
  }

  async listPages(deviceId: string): Promise<PageInfo[]> {
    await this.ensureStarted();
    const port = portFromDeviceId(deviceId);
    const pages = await fetchPagesFromBridge(port);
    return pages.map((page) => ({
      deviceId,
      pageId: page.id,
      port,
      title: page.title,
      url: page.url,
      browserName: page.browserName,
      backendHint: "iwdp_websocket",
      webSocketDebuggerUrl: page.webSocketDebuggerUrl,
      devtoolsFrontendUrl: page.devtoolsFrontendUrl,
      raw: page.raw
    }));
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + 6000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (await this.isHealthy()) {
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await delay(200);
    }
    throw new ToolError("bridge_unhealthy", "ios_webkit_debug_proxy did not become healthy in time.", {
      lastError: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
    });
  }

  private async isHealthy(): Promise<boolean> {
    const response = await fetch(`http://${this.config.bridgeHost}:${this.config.deviceListPort}`, {
      method: "GET"
    });
    return response.ok;
  }

  private pushLog(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    this.state.logs.push(`[${new Date().toISOString()}] ${trimmed}`);
    if (this.state.logs.length > 400) {
      this.state.logs.splice(0, this.state.logs.length - 400);
    }
  }
}

export function portFromDeviceId(deviceId: string): number {
  const match = deviceId.match(/(\d+)$/);
  if (!match) {
    throw new ToolError("invalid_input", `Unable to derive bridge port from device id ${deviceId}.`);
  }
  return Number(match[1]);
}

export function parseDeviceList(input: string): ParsedDevicePort[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return undefined;
          }
          const record = entry as Record<string, unknown>;
          const port = Number(record.port ?? record.debugPort ?? record.wsPort);
          const displayName = String(record.displayName ?? record.name ?? record.deviceName ?? "");
          if (!Number.isFinite(port) || !displayName) {
            return undefined;
          }
          return { displayName, port };
        })
        .filter((entry): entry is ParsedDevicePort => Boolean(entry));
    }
  } catch {
    // Fall through to HTML parsing.
  }

  const results = new Map<number, ParsedDevicePort>();
  const regex = /<a[^>]+href=["'][^"']*:(9\d{3})[^"']*["'][^>]*>(.*?)<\/a>/gims;
  for (const match of trimmed.matchAll(regex)) {
    const port = Number(match[1]);
    const rawLabel = match[2].replace(/<[^>]+>/g, "").trim();
    if (!rawLabel || !Number.isFinite(port)) {
      continue;
    }
    results.set(port, { displayName: rawLabel, port });
  }
  return [...results.values()];
}

export function parsePageList(input: string): ParsedPageDescriptor[] {
  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry, index) => parsePageDescriptorRecord(entry, index))
        .filter((entry): entry is ParsedPageDescriptor => Boolean(entry));
    }
  } catch {
    // Fall through to HTML parsing.
  }

  const descriptors: ParsedPageDescriptor[] = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gims;
  let index = 0;
  for (const match of trimmed.matchAll(regex)) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, "").trim();
    if (!title) {
      continue;
    }
    descriptors.push({
      id: `html-${index += 1}`,
      title,
      url: href.startsWith("http") ? href : "",
      browserName: detectBrowserName(title, href),
      raw: { href, title }
    });
  }
  return descriptors;
}

function parsePageDescriptorRecord(entry: unknown, index: number): ParsedPageDescriptor | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  return {
    id: String(record.id ?? record.pageId ?? `page-${index + 1}`),
    title: String(record.title ?? record.name ?? "Untitled"),
    url: String(record.url ?? ""),
    browserName: detectBrowserName(String(record.title ?? record.name ?? ""), String(record.url ?? "")),
    webSocketDebuggerUrl: typeof record.webSocketDebuggerUrl === "string" ? record.webSocketDebuggerUrl : undefined,
    devtoolsFrontendUrl: typeof record.devtoolsFrontendUrl === "string" ? record.devtoolsFrontendUrl : undefined,
    raw: record
  };
}

function detectBrowserName(title: string, url: string): string {
  const haystack = `${title} ${url}`.toLowerCase();
  if (haystack.includes("chrome")) {
    return "Chrome";
  }
  return "Safari";
}

async function fetchDevicesFromBridge(port: number): Promise<ParsedDevicePort[]> {
  const candidates = [
    `http://127.0.0.1:${port}/json`,
    `http://127.0.0.1:${port}/json/list`,
    `http://127.0.0.1:${port}/`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      const devices = parseDeviceList(text);
      if (devices.length > 0) {
        return devices;
      }
    } catch {
      // Try next endpoint.
    }
  }
  return [];
}

async function fetchPagesFromBridge(port: number): Promise<ParsedPageDescriptor[]> {
  const candidates = [
    `http://127.0.0.1:${port}/json`,
    `http://127.0.0.1:${port}/json/list`,
    `http://127.0.0.1:${port}/`
  ];
  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const text = await response.text();
      const pages = parsePageList(text);
      if (pages.length > 0) {
        return pages;
      }
    } catch {
      // Try next endpoint.
    }
  }
  return [];
}
