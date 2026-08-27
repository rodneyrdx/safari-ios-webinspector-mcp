import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ToolError } from "../errors.js";
import { ensureRemoteDebuggerTunnelRegistry } from "./remote-debugger-tunnel.js";
import { parsePageListing, selectSafariApplicationId, extractSocketPayload } from "./automation-shim.js";
import type {
  ConsoleMessage,
  DeviceInfo,
  NetworkRequestRecord,
  PageInfo,
  SessionCapabilities,
  SessionProtocol
} from "../types.js";

interface CloseNotice {
  protocolId: string;
  reason: string;
}

interface WebInspectorServiceLike {
  listenMessage(): AsyncGenerator<unknown, void, unknown>;
  stopListeningAsync(): Promise<void>;
  close(): Promise<void>;
  getConnectedApplications(): Promise<void>;
  forwardGetListing(appId: string): Promise<void>;
  forwardAutomationSessionRequest(
    sessionId: string,
    appId: string,
    capabilities?: Record<string, unknown>
  ): Promise<void>;
  forwardSocketSetup(
    sessionId: string,
    appId: string,
    pageId: number,
    automaticallyPause?: boolean
  ): Promise<void>;
  forwardSocketData(
    sessionId: string,
    appId: string,
    pageId: number,
    data: unknown
  ): Promise<void>;
}

interface RemoteXpcLike {
  close(): Promise<void>;
}

interface ShimConnection {
  webInspectorService: WebInspectorServiceLike;
  remoteXPC?: RemoteXpcLike;
}

interface AutomationConnectionLike {
  createBrowsingContext(): Promise<ManagedContext>;
  navigate(handle: string, url: string): Promise<void>;
  goBack(handle: string): Promise<void>;
  goForward(handle: string): Promise<void>;
  reload(handle: string): Promise<void>;
  evaluateExpression(handle: string, expression: string): Promise<unknown>;
  currentUrl(handle: string): Promise<string>;
  title(handle: string): Promise<string>;
  takeScreenshot(handle: string): Promise<string>;
  closeBrowsingContext(handle: string): Promise<void>;
  deleteSession(): Promise<void>;
  close(): Promise<void>;
}

export class AutomationManagedManager {
  constructor(private readonly timeoutMs: number) {}

  async createManagedSession(
    device: DeviceInfo,
    url: string,
    onClosed: (notice: CloseNotice) => void,
    factory: AutomationConnectionFactory = openAutomationConnection
  ): Promise<{ page: PageInfo; protocol: SessionProtocol; capabilities: SessionCapabilities }> {
    if (!device.physicalId) {
      throw new ToolError("device_unavailable", "A physical iPhone UDID is required for Automation-managed sessions.", {
        deviceId: device.deviceId,
        displayName: device.displayName
      });
    }

    const connection = await factory(device.physicalId, this.timeoutMs);
    const created = await createManagedBrowsingContext(connection, url);

    try {
      const session = new AutomationManagedSession(connection, created.handle, onClosed);
      const [pageUrl, title, capabilities] = await Promise.all([
        connection.currentUrl(created.handle).catch(() => url),
        connection.title(created.handle).catch(() => "Automation Safari Session"),
        session.initializeCapabilities()
      ]);

      const page: PageInfo = {
        deviceId: device.deviceId,
        pageId: `automation-${created.handle}`,
        port: 0,
        title,
        url: pageUrl,
        browserName: "Safari",
        backendHint: "automation_shim_managed",
        raw: {
          browsingContextHandle: created.handle,
          presentation: created.presentation
        }
      };

      return {
        page,
        protocol: session,
        capabilities
      };
    } catch (error) {
      await connection.closeBrowsingContext(created.handle).catch(() => undefined);
      await connection.close().catch(() => undefined);
      throw error;
    }
  }
}

export class AutomationManagedSession implements SessionProtocol {
  readonly id = randomUUID();
  private readonly consoleMessages: ConsoleMessage[] = [];
  private readonly networkRequests: NetworkRequestRecord[] = [];
  private closed = false;
  private notifyOnClose = true;

  constructor(
    private readonly connection: AutomationConnectionLike,
    private readonly browsingContextHandle: string,
    private readonly onClosed: (notice: CloseNotice) => void
  ) {}

  async waitUntilOpen(): Promise<void> {}

  async initializeCapabilities(): Promise<SessionCapabilities> {
    return {
      backend: "automation_shim_managed",
      runtimeEval: true,
      console: false,
      network: false,
      domSnapshot: true,
      domActions: true,
      screenshot: true,
      uiRecovery: false,
      transportMode: "direct",
      notes: [
        "Managed iPhone Safari automation through the raw WebInspector Automation domain.",
        "Automation browsing contexts are isolated from the user's normal Safari tabs on this path.",
        "Console and network streaming are not exposed through the current Automation backend."
      ]
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    try {
      return { value: await this.connection.evaluateExpression(this.browsingContextHandle, expression) };
    } catch (error) {
      this.handleUnexpectedClose(error);
      throw error;
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      switch (method) {
        case "Runtime.evaluate":
          return {
            result: await this.evaluate(String(params.expression ?? "undefined"))
          };
        case "Page.captureScreenshot":
          return {
            data: await this.connection.takeScreenshot(this.browsingContextHandle)
          };
        case "Page.navigate": {
          const url = String(params.url ?? "");
          if (!url) {
            throw new ToolError("invalid_input", "Page.navigate requires a non-empty url parameter.");
          }
          await this.connection.navigate(this.browsingContextHandle, url);
          return {};
        }
        case "Page.goBack":
          await this.connection.goBack(this.browsingContextHandle);
          return {};
        case "Page.goForward":
          await this.connection.goForward(this.browsingContextHandle);
          return {};
        case "Page.reload":
          await this.connection.reload(this.browsingContextHandle);
          return {};
        default:
          throw new ToolError("unsupported", `Automation backend does not implement ${method}.`, {
            backend: "automation_shim_managed"
          });
      }
    } catch (error) {
      this.handleUnexpectedClose(error);
      throw error;
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
    void this.disposeAsync();
  }

  dispose(): void {
    this.notifyOnClose = false;
    void this.disposeAsync();
  }

  private async disposeAsync(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.connection.closeBrowsingContext(this.browsingContextHandle).catch(() => undefined);
    await this.connection.close().catch(() => undefined);
  }

  private handleUnexpectedClose(error: unknown): void {
    if (this.closed || !this.notifyOnClose) {
      return;
    }
    if (!(error instanceof ToolError) || error.code !== "not_attached") {
      return;
    }
    this.closed = true;
    this.onClosed({
      protocolId: this.id,
      reason: error.message
    });
  }
}

type AutomationConnectionFactory = (udid: string, timeoutMs: number) => Promise<AutomationConnectionLike>;

type ManagedContext = {
  handle: string;
  presentation?: string;
};

async function createManagedBrowsingContext(
  connection: AutomationConnectionLike,
  url: string
): Promise<ManagedContext> {
  const created = await connection.createBrowsingContext();
  await connection.navigate(created.handle, url);
  return created;
}

export async function openAutomationConnection(
  udid: string,
  timeoutMs: number
): Promise<AutomationManagedConnection> {
  await ensureRemoteDebuggerTunnelRegistry().catch(() => undefined);
  const { Services } = await import("appium-ios-remotexpc");
  const connection = await Services.startWebInspectorService(udid) as ShimConnection;
  const collector = new ShimMessageCollector(connection.webInspectorService);
  const sessionId = randomUUID().toUpperCase();
  collector.start();

  try {
    const appsIndex = collector.snapshotIndex();
    await connection.webInspectorService.getConnectedApplications();
    const applications = await collector.waitForSince(
      appsIndex,
      extractConnectedApplications,
      timeoutMs,
      "connected applications"
    );
    const appId = selectSafariApplicationId(applications);
    if (!appId) {
      throw new ToolError("device_unavailable", "Mobile Safari was not exposed by the WebInspector shim.", {
        udid
      });
    }

    const listingIndex = collector.snapshotIndex();
    await connection.webInspectorService.forwardGetListing(appId);
    await collector.waitForSince(listingIndex, (message) => extractListing(message, appId), timeoutMs, "Safari page listing");

    const automationIndex = collector.snapshotIndex();
    await connection.webInspectorService.forwardAutomationSessionRequest(sessionId, appId);
    const automationListing = await collector.waitForSince(
      automationIndex,
      (message) => {
        const listing = extractListing(message, appId);
        if (!listing) {
          return undefined;
        }
        return parsePageListing(listing).some((page) => page.type === "WIRTypeAutomation") ? listing : undefined;
      },
      timeoutMs,
      "automation page listing"
    );

    const automationPage = parsePageListing(automationListing)
      .filter((page) => page.type === "WIRTypeAutomation")
      .at(-1);
    if (!automationPage) {
      throw new ToolError("unsupported", "Safari did not expose an Automation page for the requested session.", {
        udid,
        appId
      });
    }

    await connection.webInspectorService.forwardSocketSetup(sessionId, appId, automationPage.pageId, false);
    await delay(150);

    return new AutomationManagedConnection(
      connection.webInspectorService,
      connection.remoteXPC,
      collector,
      sessionId,
      appId,
      automationPage.pageId,
      timeoutMs
    );
  } catch (error) {
    await collector.stop().catch(() => undefined);
    await connection.webInspectorService.close().catch(() => undefined);
    await connection.remoteXPC?.close().catch(() => undefined);
    throw error;
  }
}

export class AutomationManagedConnection implements AutomationConnectionLike {
  private commandId = 0;
  private closed = false;

  constructor(
    private readonly service: WebInspectorServiceLike,
    private readonly remoteXPC: RemoteXpcLike | undefined,
    private readonly collector: ShimMessageCollector,
    private readonly sessionId: string,
    private readonly appId: string,
    private readonly automationPageId: number,
    private readonly timeoutMs: number
  ) {}

  async createBrowsingContext(): Promise<ManagedContext> {
    const result = await this.sendCommand("Automation.createBrowsingContext", {
      presentationHint: "Tab"
    });
    const payload = asRecord(result.result);
    const handle = typeof payload?.handle === "string" ? payload.handle : undefined;
    if (!handle) {
      throw new ToolError("internal_error", "Automation.createBrowsingContext did not return a handle.", {
        payload: result
      });
    }
    return {
      handle,
      presentation: typeof payload?.presentation === "string" ? payload.presentation : undefined
    };
  }

  async navigate(handle: string, url: string): Promise<void> {
    await this.sendCommand("Automation.navigateBrowsingContext", {
      handle,
      url,
      pageLoadStrategy: "Normal",
      pageLoadTimeout: this.timeoutMs
    });
  }

  async goBack(handle: string): Promise<void> {
    await this.sendCommand("Automation.goBackInBrowsingContext", {
      handle,
      pageLoadStrategy: "Normal",
      pageLoadTimeout: this.timeoutMs
    });
  }

  async goForward(handle: string): Promise<void> {
    await this.sendCommand("Automation.goForwardInBrowsingContext", {
      handle,
      pageLoadStrategy: "Normal",
      pageLoadTimeout: this.timeoutMs
    });
  }

  async reload(handle: string): Promise<void> {
    await this.sendCommand("Automation.reloadBrowsingContext", {
      handle,
      pageLoadStrategy: "Normal",
      pageLoadTimeout: this.timeoutMs
    });
  }

  async evaluateExpression(handle: string, expression: string): Promise<unknown> {
    const script = buildSerializableExpression(expression);
    const result = await this.sendCommand("Automation.evaluateJavaScriptFunction", {
      browsingContextHandle: handle,
      function: script,
      arguments: []
    });
    return unwrapAutomationResult(asRecord(result.result)?.result);
  }

  async currentUrl(handle: string): Promise<string> {
    const value = await this.evaluateExpression(handle, "location.href");
    return typeof value === "string" ? value : String(value ?? "");
  }

  async title(handle: string): Promise<string> {
    const value = await this.evaluateExpression(handle, "document.title");
    return typeof value === "string" ? value : String(value ?? "");
  }

  async takeScreenshot(handle: string): Promise<string> {
    const result = await this.sendCommand("Automation.takeScreenshot", { handle });
    const data = asRecord(result.result)?.data;
    if (typeof data !== "string" || data.length === 0) {
      throw new ToolError("unsupported", "Automation.takeScreenshot did not return screenshot data.", {
        backend: "automation_shim_managed"
      });
    }
    return data;
  }

  async closeBrowsingContext(handle: string): Promise<void> {
    if (!handle) {
      return;
    }
    await this.sendCommand("Automation.closeBrowsingContext", { handle }).catch(() => undefined);
  }

  async deleteSession(): Promise<void> {
    await this.sendCommand("Automation.deleteSession", {}).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.deleteSession().catch(() => undefined);
    await this.collector.stop().catch(() => undefined);
    await this.service.close().catch(() => undefined);
    await this.remoteXPC?.close().catch(() => undefined);
  }

  private async sendCommand(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new ToolError("not_attached", "The Automation session is already closed.", {
        backend: "automation_shim_managed"
      });
    }

    const startIndex = this.collector.snapshotIndex();
    const id = ++this.commandId;
    await this.service.forwardSocketData(this.sessionId, this.appId, this.automationPageId, {
      id,
      method,
      params
    });

    const result = await this.collector.waitForSince(
      startIndex,
      (message) => {
        const payload = extractSocketPayload(message);
        if (!payload || payload.id !== id) {
          return undefined;
        }
        return payload;
      },
      this.timeoutMs,
      `${method} response`
    );

    if (result.error) {
      throw mapAutomationError(method, result.error);
    }
    return result;
  }
}

function extractConnectedApplications(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, any>;
  if (record.__selector !== "_rpc_reportConnectedApplicationList:") {
    return undefined;
  }
  return asRecord(record.__argument?.WIRApplicationDictionaryKey) ?? undefined;
}

function extractListing(message: unknown, appId: string): Record<string, unknown> | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as Record<string, any>;
  if (record.__selector !== "_rpc_applicationSentListing:") {
    return undefined;
  }
  if (record.__argument?.WIRApplicationIdentifierKey !== appId) {
    return undefined;
  }
  return asRecord(record.__argument?.WIRListingKey) ?? undefined;
}

function mapAutomationError(method: string, error: unknown): ToolError {
  const record = asRecord(error);
  const message = String(record?.message ?? error ?? `${method} failed.`);
  const lower = message.toLowerCase();
  if (lower.includes("timeout")) {
    return new ToolError("timeout", message, { backend: "automation_shim_managed", method, error });
  }
  if (lower.includes("windownotfound") || lower.includes("framenotfound")) {
    return new ToolError("not_attached", message, { backend: "automation_shim_managed", method, error });
  }
  return new ToolError("unsupported", message, { backend: "automation_shim_managed", method, error });
}

function buildSerializableExpression(expression: string): string {
  const source = JSON.stringify(expression);
  return `function () {
    const __swiValue = (0, eval)(${source});
    if (__swiValue === undefined) {
      return { __swiKind: "undefined" };
    }
    try {
      return { __swiKind: "json", json: JSON.stringify(__swiValue) };
    } catch (error) {
      return { __swiKind: "string", value: String(__swiValue) };
    }
  }`;
}

function unwrapAutomationResult(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return parsed;
    }
    const record = parsed as Record<string, unknown>;
    if (record.__swiKind === "undefined") {
      return undefined;
    }
    if (record.__swiKind === "json" && typeof record.json === "string") {
      try {
        return JSON.parse(record.json);
      } catch {
        return record.json;
      }
    }
    if (record.__swiKind === "string") {
      return record.value;
    }
    return parsed;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" ? value as Record<string, any> : undefined;
}

class ShimMessageCollector {
  private readonly messages: unknown[] = [];
  private failure?: Error;
  private listenerTask?: Promise<void>;
  private stopped = false;

  constructor(private readonly service: WebInspectorServiceLike) {}

  start(): void {
    if (this.listenerTask) {
      return;
    }

    this.listenerTask = (async () => {
      try {
        for await (const message of this.service.listenMessage()) {
          if (this.stopped) {
            break;
          }
          this.messages.push(message);
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    })();
  }

  snapshotIndex(): number {
    return this.messages.length;
  }

  async waitForSince<T>(
    index: number,
    matcher: (message: unknown) => T | undefined,
    timeoutMs: number,
    description: string
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let cursor = index;

    while (Date.now() < deadline) {
      while (cursor < this.messages.length) {
        const message = this.messages[cursor];
        cursor += 1;
        const match = matcher(message);
        if (match !== undefined) {
          return match;
        }
      }

      if (this.failure) {
        throw new ToolError("bridge_unhealthy", this.failure.message, {
          backend: "automation_shim_managed"
        });
      }

      await delay(25);
    }

    throw new ToolError("timeout", `Timed out waiting for ${description}.`, {
      backend: "automation_shim_managed"
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.service.stopListeningAsync().catch(() => undefined);
    await this.listenerTask?.catch(() => undefined);
  }
}
