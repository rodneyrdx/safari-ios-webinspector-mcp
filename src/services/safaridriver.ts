import fs from "node:fs/promises";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { ToolError } from "../errors.js";
import type {
  ConsoleMessage,
  DeviceInfo,
  NetworkRequestRecord,
  PageInfo,
  SessionCapabilities,
  SessionProtocol
} from "../types.js";
import { ensureDir } from "../utils/fs.js";
import { commandPath } from "../utils/exec.js";

interface SafariDriverState {
  process?: ChildProcessWithoutNullStreams;
  startedAt?: string;
  logs: string[];
  externalRunning?: boolean;
}

interface CreateSessionResult {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

interface CloseNotice {
  protocolId: string;
  reason: string;
}

export class SafariDriverManager {
  private readonly state: SafariDriverState = { logs: [] };

  constructor(private readonly config: AppConfig) {}

  async ensureStarted(): Promise<{ baseUrl: string; running: boolean; pid?: number; recentLogs: string[] }> {
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

    const command = await commandPath(this.config.webDriverCommand);
    if (!command) {
      throw new ToolError("dependency_missing", "safaridriver is not installed.");
    }

    await ensureDir(this.config.cacheDir);

    const child = spawn(command, ["-p", String(this.config.webDriverPort)], {
      env: process.env,
      stdio: "pipe"
    });

    this.state.process = child;
    this.state.startedAt = new Date().toISOString();

    child.stdout.on("data", (chunk) => this.pushLog(String(chunk)));
    child.stderr.on("data", (chunk) => this.pushLog(String(chunk)));
    child.on("exit", (code, signal) => {
      this.pushLog(`safaridriver exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      this.state.process = undefined;
      this.state.externalRunning = false;
    });

    await this.waitForHealth();
    this.state.externalRunning = false;
    return this.getStatus();
  }

  async createManagedSession(
    device: DeviceInfo,
    url: string,
    onClosed: (notice: CloseNotice) => void
  ): Promise<{ page: PageInfo; protocol: SessionProtocol; capabilities: SessionCapabilities }> {
    const udid = device.physicalId;
    if (!udid) {
      throw new ToolError("device_unavailable", "A physical iPhone UDID is required for managed Safari sessions.", {
        deviceId: device.deviceId,
        displayName: device.displayName
      });
    }

    const { baseUrl } = await this.ensureStarted();
    const created = await createSession(baseUrl, {
      browserName: "Safari",
      platformName: "iOS",
      "safari:useSimulator": false,
      "safari:deviceUDID": udid,
      "safari:deviceName": device.displayName,
      "safari:automaticInspection": true
    });

    const session = new WebDriverSession(baseUrl, created.sessionId, onClosed);
    await session.waitUntilOpen();
    await session.navigate(url);

    const [pageUrl, title] = await Promise.all([
      session.currentUrl().catch(() => url),
      session.title().catch(() => "Managed Safari Session")
    ]);

    const page: PageInfo = {
      deviceId: device.deviceId,
      pageId: `managed-${created.sessionId}`,
      port: 0,
      title,
      url: pageUrl,
      browserName: "Safari",
      backendHint: "webdriver_managed",
      raw: {
        sessionId: created.sessionId,
        capabilities: created.capabilities
      }
    };

    return {
      page,
      protocol: session,
      capabilities: await session.initializeCapabilities()
    };
  }

  private getStatus() {
    return {
      baseUrl: buildBaseUrl(this.config.webDriverPort),
      running: Boolean(this.state.externalRunning || (this.state.process && !this.state.process.killed)),
      pid: this.state.process?.pid,
      recentLogs: this.state.logs.slice(-40)
    };
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
    throw new ToolError("bridge_unhealthy", "safaridriver did not become healthy in time.", {
      lastError: lastError instanceof Error ? lastError.message : String(lastError ?? "unknown")
    });
  }

  private async isHealthy(): Promise<boolean> {
    const response = await fetch(`${buildBaseUrl(this.config.webDriverPort)}/status`, {
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

export class WebDriverSession implements SessionProtocol {
  readonly id = randomUUID();
  private closed = false;
  private notifyOnClose = true;
  private readonly consoleMessages: ConsoleMessage[] = [];
  private readonly networkRequests: NetworkRequestRecord[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly webdriverSessionId: string,
    private readonly onClosed: (notice: CloseNotice) => void
  ) {}

  async waitUntilOpen(): Promise<void> {}

  async initializeCapabilities(): Promise<SessionCapabilities> {
    return {
      backend: "webdriver_managed",
      runtimeEval: true,
      console: false,
      network: false,
      domSnapshot: true,
      domActions: true,
      screenshot: true,
      uiRecovery: false,
      transportMode: "direct",
      notes: [
        "Managed Safari automation on iPhone is isolated from normal tabs by safaridriver.",
        "Console and network streaming are not exposed through safaridriver in this backend."
      ]
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    const value = await this.executeScript(buildSerializableExpression(expression));
    return { value };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    switch (method) {
      case "Runtime.evaluate":
        return {
          result: await this.evaluate(String(params.expression ?? "undefined"))
        };
      case "Page.captureScreenshot":
        return {
          data: await this.takeScreenshotBase64()
        };
      case "Page.reload":
        await this.refresh();
        return {};
      case "Page.navigate": {
        const url = String(params.url ?? "");
        if (!url) {
          throw new ToolError("invalid_input", "Page.navigate requires a non-empty url parameter.");
        }
        await this.navigate(url);
        return {};
      }
      case "Page.goBack":
        await this.back();
        return {};
      case "Page.goForward":
        await this.forward();
        return {};
      default:
        throw new ToolError("unsupported", `WebDriver backend does not implement ${method}.`, {
          backend: "webdriver_managed"
        });
    }
  }

  getConsoleMessages(): ConsoleMessage[] {
    return this.consoleMessages.slice();
  }

  getNetworkRequests(): NetworkRequestRecord[] {
    return this.networkRequests.slice();
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.notifyOnClose = false;
    void this.deleteSession();
  }

  dispose(): void {
    this.notifyOnClose = false;
    void this.deleteSession();
  }

  async navigate(url: string): Promise<void> {
    await this.sessionRequest("POST", "/url", { url });
  }

  async currentUrl(): Promise<string> {
    const response = await this.sessionRequest("GET", "/url");
    return String(response.value ?? "");
  }

  async title(): Promise<string> {
    const response = await this.sessionRequest("GET", "/title");
    return String(response.value ?? "");
  }

  async back(): Promise<void> {
    await this.sessionRequest("POST", "/back");
  }

  async forward(): Promise<void> {
    await this.sessionRequest("POST", "/forward");
  }

  private async refresh(): Promise<void> {
    await this.sessionRequest("POST", "/refresh");
  }

  private async takeScreenshotBase64(): Promise<string> {
    const response = await this.sessionRequest("GET", "/screenshot");
    const data = response.value;
    if (typeof data !== "string" || data.length === 0) {
      throw new ToolError("unsupported", "safaridriver did not return screenshot data.");
    }
    return data;
  }

  private async executeScript(script: string): Promise<unknown> {
    const response = await this.sessionRequest("POST", "/execute/sync", {
      script,
      args: []
    });
    if ("value" in response) {
      return unwrapWebDriverExecuteValue(response.value);
    }
    return unwrapWebDriverExecuteValue(response);
  }

  private async sessionRequest(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new ToolError("not_attached", "The Safari WebDriver session is already closed.");
    }

    const init: RequestInit = {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/session/${this.webdriverSessionId}${path}`, init);
    } catch (error) {
      this.emitClosed(`safaridriver request failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }

    const payload = await parseJson(response);
    if (!response.ok) {
      this.handleErrorPayload(payload, response.status);
    }

    const value = asRecord(payload.value);
    if (payload.value && typeof payload.value === "object") {
      return value;
    }
    return payload;
  }

  private async deleteSession(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      await fetch(`${this.baseUrl}/session/${this.webdriverSessionId}`, {
        method: "DELETE"
      });
    } catch {
      // Best effort cleanup only.
    }
  }

  private handleErrorPayload(payload: Record<string, unknown>, status: number): never {
    const value = asRecord(payload.value);
    const error = String(value.error ?? payload.error ?? `HTTP ${status}`);
    const message = String(value.message ?? payload.message ?? error);

    if (error.toLowerCase().includes("invalid session")) {
      this.emitClosed(message);
      throw new ToolError("not_attached", message, { backend: "webdriver_managed" });
    }

    if (error.toLowerCase().includes("timeout")) {
      throw new ToolError("timeout", message, { backend: "webdriver_managed" });
    }

    throw new ToolError("unsupported", message, {
      backend: "webdriver_managed",
      error,
      payload
    });
  }

  private emitClosed(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.notifyOnClose) {
      this.onClosed({ protocolId: this.id, reason });
    }
  }
}

export async function writeWebDriverScreenshot(
  protocol: SessionProtocol,
  filePath: string
): Promise<boolean> {
  try {
    const result = await protocol.request("Page.captureScreenshot");
    if (typeof result.data !== "string" || result.data.length === 0) {
      return false;
    }
    await fs.writeFile(filePath, Buffer.from(result.data, "base64"));
    return true;
  } catch {
    return false;
  }
}

async function createSession(
  baseUrl: string,
  capabilities: Record<string, unknown>
): Promise<CreateSessionResult> {
  const response = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: capabilities
      }
    })
  });

  const payload = await parseJson(response);
  if (!response.ok) {
    const value = asRecord(payload.value);
    throw new ToolError("unsupported", String(value.message ?? "Failed to create Safari WebDriver session."), {
      backend: "webdriver_managed",
      payload
    });
  }

  const value = asRecord(payload.value);
  const sessionId = typeof value.sessionId === "string"
    ? value.sessionId
    : typeof payload.sessionId === "string"
      ? payload.sessionId
      : undefined;

  if (!sessionId) {
    throw new ToolError("internal_error", "safaridriver did not return a session id.", {
      payload
    });
  }

  return {
    sessionId,
    capabilities: asRecord(value.capabilities)
  };
}

function buildBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {
      value: {
        message: text
      }
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  return value as Record<string, unknown>;
}

function buildSerializableExpression(expression: string): string {
  return `
    const __swiValue = (${expression});
    if (__swiValue === undefined) {
      return { __swiKind: "undefined" };
    }
    try {
      return { __swiKind: "json", json: JSON.stringify(__swiValue) };
    } catch (error) {
      return { __swiKind: "string", value: String(__swiValue) };
    }
  `;
}

function unwrapWebDriverExecuteValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const kind = record.__swiKind;
  if (kind === "undefined") {
    return undefined;
  }
  if (kind === "json" && typeof record.json === "string") {
    try {
      return JSON.parse(record.json);
    } catch {
      return record.json;
    }
  }
  if (kind === "string") {
    return record.value;
  }
  return value;
}
