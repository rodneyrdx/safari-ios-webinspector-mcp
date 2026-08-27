import { randomUUID } from "node:crypto";
import { ToolError } from "../errors.js";
import { ensureRemoteDebuggerTunnelRegistry } from "./remote-debugger-tunnel.js";
import type {
  ConsoleMessage,
  DeviceInfo,
  NetworkRequestRecord,
  PageInfo,
  SessionCapabilities,
  SessionProtocol
} from "../types.js";

type RemoteDebuggerPage = {
  id: string | number;
  url: string;
  title: string;
  isKey: boolean;
  bundleId?: string;
};

type ConsoleListener = (error?: Error | null, event?: Record<string, unknown>, method?: string) => void;
type NetworkListener = (error?: Error | null, event?: Record<string, unknown>, method?: string) => void;

export interface RemoteDebuggerLike {
  connect(timeout?: number): Promise<Record<string, unknown>>;
  disconnect(): Promise<void>;
  selectApp(currentUrl?: string | null, maxTries?: number, ignoreAboutBlankUrl?: boolean): Promise<RemoteDebuggerPage[]>;
  selectPage(appIdKey: string | number, pageIdKey: string | number, skipReadyCheck?: boolean): Promise<void>;
  execute(command: string): Promise<unknown>;
  captureScreenshot(): Promise<string>;
  startConsole(listener: ConsoleListener): void;
  stopConsole(): void;
  startNetwork(listener: NetworkListener): void;
  stopNetwork(): void;
  readonly appDict: Record<string, { pageArray?: RemoteDebuggerPage[] }>;
  readonly useWebInspectorShim?: boolean;
  _appIdKey?: string | number;
}

export interface AttachedRemoteDebuggerTarget {
  page: PageInfo;
  protocol: SessionProtocol;
  capabilities: SessionCapabilities;
}

type AttachOptions = {
  selectPageTimeoutMs?: number;
};

export async function attachWithAppiumRemoteDebugger(
  device: DeviceInfo,
  page: PageInfo,
  onClosed: (notice: { protocolId: string; reason: string }) => void,
  factory: RemoteDebuggerFactory = defaultFactory,
  options: AttachOptions = {}
): Promise<AttachedRemoteDebuggerTarget> {
  if (!device.physicalId) {
    throw new ToolError("device_unavailable", "Appium remote debugger requires a physical iPhone UDID.", {
      deviceId: device.deviceId
    });
  }

  if (requiresRemoteDebuggerTunnel(device.iosVersion)) {
    await ensureRemoteDebuggerTunnelRegistry().catch(() => undefined);
  }

  const remoteDebugger = await factory({
    udid: device.physicalId,
    platformVersion: device.iosVersion,
    isSafari: true,
    includeSafari: true,
    bundleId: "com.apple.mobilesafari",
    pageLoadMs: 5000,
    fullPageInitialization: true
  });

  await remoteDebugger.connect(5000);

  try {
    const selected = await selectMatchingPage(remoteDebugger, page);
    await selectExistingPage(remoteDebugger, selected, page, options.selectPageTimeoutMs);

    const protocol = new AppiumRemoteDebuggerSession(remoteDebugger, onClosed, {
      appIdKey: selected.appIdKey,
      pageIdKey: selected.pageIdKey,
      url: selected.page.url,
      title: selected.page.title
    });
    const capabilities = await protocol.initializeCapabilities();

    return {
      page: {
        ...page,
        backendHint: "remote_debugger_attached",
        raw: {
          ...page.raw,
          appium: {
            appIdKey: String(selected.appIdKey),
            pageIdKey: String(selected.pageIdKey),
            useWebInspectorShim: Boolean(remoteDebugger.useWebInspectorShim)
          }
        }
      },
      protocol,
      capabilities
    };
  } catch (error) {
    await remoteDebugger.disconnect().catch(() => undefined);
    throw error;
  }
}

class AppiumRemoteDebuggerSession implements SessionProtocol {
  readonly id = randomUUID();
  private readonly consoleMessages: ConsoleMessage[] = [];
  private readonly networkRequests: NetworkRequestRecord[] = [];
  private closed = false;
  private initialized = false;

  constructor(
    private readonly remoteDebugger: RemoteDebuggerLike,
    private readonly onClosed: (notice: { protocolId: string; reason: string }) => void,
    private readonly selectedPage: {
      appIdKey: string | number;
      pageIdKey: string | number;
      url: string;
      title: string;
    }
  ) {}

  async waitUntilOpen(): Promise<void> {}

  async initializeCapabilities(): Promise<SessionCapabilities> {
    if (!this.initialized) {
      this.remoteDebugger.startConsole((error, event, method) => {
        if (error) {
          this.recordClose(`console listener error: ${error.message}`);
          return;
        }
        if (!event) {
          return;
        }
        this.consoleMessages.push(normalizeConsoleMessage(event, method));
        trimArray(this.consoleMessages, 500);
      });
      this.remoteDebugger.startNetwork((error, event, method) => {
        if (error) {
          this.recordClose(`network listener error: ${error.message}`);
          return;
        }
        if (!event) {
          return;
        }
        const record = normalizeNetworkEvent(event, method);
        if (record) {
          this.networkRequests.push(record);
          trimArray(this.networkRequests, 500);
        }
      });
      this.initialized = true;
    }

    return {
      backend: "remote_debugger_attached",
      runtimeEval: true,
      console: true,
      network: true,
      domSnapshot: true,
      domActions: true,
      screenshot: true,
      uiRecovery: true,
      transportMode: "direct",
      notes: this.remoteDebugger.useWebInspectorShim
        ? ["Connected through the Appium WebInspector shim path for iOS 18+."]
        : ["Connected through the Appium legacy Web Inspector path."]
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.ensureOpen();
    const value = await this.remoteDebugger.execute(expression);
    return { value };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.ensureOpen();
    switch (method) {
      case "Runtime.evaluate":
        return {
          result: await this.evaluate(String(params.expression ?? "undefined"))
        };
      case "Page.captureScreenshot":
        return {
          data: await this.remoteDebugger.captureScreenshot()
        };
      case "Page.reload":
        await this.remoteDebugger.execute("location.reload(); true;");
        return {};
      case "Page.navigate": {
        const url = String(params.url ?? "");
        if (!url) {
          throw new ToolError("invalid_input", "Page.navigate requires a non-empty url parameter.");
        }
        await this.remoteDebugger.execute(`location.href = ${JSON.stringify(url)}; true;`);
        return {};
      }
      case "Page.goBack":
        await this.remoteDebugger.execute("history.back(); true;");
        return {};
      case "Page.goForward":
        await this.remoteDebugger.execute("history.forward(); true;");
        return {};
      default:
        throw new ToolError("unsupported", `Appium remote debugger backend does not implement ${method}.`, {
          backend: "remote_debugger_attached"
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
    void this.disposeAsync(false);
  }

  dispose(): void {
    void this.disposeAsync(false);
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new ToolError("not_attached", "The Appium remote debugger session is already closed.");
    }
  }

  private async disposeAsync(notify: boolean): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.remoteDebugger.stopConsole();
      this.remoteDebugger.stopNetwork();
    } catch {
      // Ignore listener cleanup errors.
    }
    try {
      await this.remoteDebugger.disconnect();
    } catch (error) {
      if (notify) {
        this.onClosed({
          protocolId: this.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private recordClose(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClosed({
      protocolId: this.id,
      reason
    });
  }
}

async function defaultFactory(options: Record<string, unknown>): Promise<RemoteDebuggerLike> {
  const module = await import("appium-remote-debugger");
  return module.createRemoteDebugger(options as never, true) as unknown as RemoteDebuggerLike;
}

async function selectMatchingPage(
  remoteDebugger: RemoteDebuggerLike,
  requestedPage: PageInfo
): Promise<{ appIdKey: string | number; pageIdKey: string | number; page: RemoteDebuggerPage }> {
  const searchUrls = [requestedPage.url, requestedPage.url.replace(/\/$/, ""), `${requestedPage.url}/`]
    .map((url) => url.trim())
    .filter(Boolean);

  for (const searchUrl of [...new Set(searchUrls)]) {
    const pages = await remoteDebugger.selectApp(searchUrl, 10, false);
    const selected = findSelectedPage(remoteDebugger, pages, requestedPage);
    if (selected) {
      return selected;
    }
  }

  const pages = await remoteDebugger.selectApp(null, 5, false);
  const selected = findSelectedPage(remoteDebugger, pages, requestedPage);
  if (selected) {
    return selected;
  }

  throw new ToolError("page_not_found", `Appium remote debugger could not match an existing Safari tab for ${requestedPage.url}.`, {
    requestedPage
  });
}

function findSelectedPage(
  remoteDebugger: RemoteDebuggerLike,
  pages: RemoteDebuggerPage[],
  requestedPage: PageInfo
): { appIdKey: string | number; pageIdKey: string | number; page: RemoteDebuggerPage } | undefined {
  const currentAppId = remoteDebugger._appIdKey;
  if (!currentAppId) {
    return undefined;
  }

  const appPages = remoteDebugger.appDict[String(currentAppId)]?.pageArray ?? [];
  const allCandidates = appPages.length > 0 ? appPages : pages;
  const normalizedRequestedUrl = requestedPage.url.replace(/\/$/, "");

  const matched = allCandidates.find((candidate) =>
    candidate.url.replace(/\/$/, "") === normalizedRequestedUrl
    || candidate.title === requestedPage.title
  );

  if (!matched) {
    return undefined;
  }

  return {
    appIdKey: currentAppId,
    pageIdKey: matched.id,
    page: matched
  };
}

function normalizeConsoleMessage(event: Record<string, unknown>, method = "Console.messageAdded"): ConsoleMessage {
  const text = typeof event.text === "string"
    ? event.text
    : typeof event.message === "string"
      ? event.message
      : JSON.stringify(event);
  return {
    timestamp: new Date().toISOString(),
    level: normalizeLevel(String(event.level ?? event.type ?? "log")),
    text,
    source: typeof event.source === "string" ? event.source : "Console",
    method
  };
}

function normalizeNetworkEvent(
  event: Record<string, unknown>,
  method = "NetworkEvent"
): NetworkRequestRecord | undefined {
  const request = typeof event.request === "object" && event.request !== null
    ? event.request as Record<string, unknown>
    : undefined;
  const response = typeof event.response === "object" && event.response !== null
    ? event.response as Record<string, unknown>
    : undefined;

  const url = String(
    event.url
    ?? request?.url
    ?? response?.url
    ?? ""
  );
  if (!url) {
    return undefined;
  }

  return {
    id: String(event.requestId ?? event.identifier ?? randomUUID()),
    timestamp: new Date().toISOString(),
    url,
    method: typeof request?.method === "string" ? request.method : undefined,
    status: typeof response?.status === "number" ? response.status : undefined,
    mimeType: typeof response?.mimeType === "string" ? response.mimeType : undefined,
    resourceType: typeof event.type === "string" ? event.type : method
  };
}

function normalizeLevel(level: string): ConsoleMessage["level"] {
  const lower = level.toLowerCase();
  if (lower.includes("warn")) {
    return "warning";
  }
  if (lower.includes("error")) {
    return "error";
  }
  if (lower.includes("info")) {
    return "info";
  }
  return "log";
}

function trimArray<T>(items: T[], maxSize: number): void {
  if (items.length <= maxSize) {
    return;
  }
  items.splice(0, items.length - maxSize);
}

type RemoteDebuggerFactory = (options: Record<string, unknown>) => Promise<RemoteDebuggerLike>;

async function selectExistingPage(
  remoteDebugger: RemoteDebuggerLike,
  selected: { appIdKey: string | number; pageIdKey: string | number; page: RemoteDebuggerPage },
  requestedPage: PageInfo,
  selectPageTimeoutMs = 20_000
): Promise<void> {
  try {
    await promiseWithTimeout(
      remoteDebugger.selectPage(selected.appIdKey, selected.pageIdKey, false),
      selectPageTimeoutMs,
      `Timed out selecting page '${selected.pageIdKey}' for app '${selected.appIdKey}'.`
    );
  } catch (error) {
    if (remoteDebugger.useWebInspectorShim && isTimeoutError(error)) {
      throw new ToolError(
        "unsupported",
        "The Appium WebInspector shim connected, but Safari did not expose a selectable existing-tab target. Current evidence points to an isolated Automation-only shim surface rather than adoption of the normal Safari tab.",
        {
          requestedPage,
          appIdKey: String(selected.appIdKey),
          pageIdKey: String(selected.pageIdKey),
          useWebInspectorShim: true,
          automationDomainDetected: true,
          attachExistingTabSupported: false,
          recommendedAlternative: "Use launch_managed_page for reliable page control. Safari automation windows are isolated from normal browsing windows on this path."
        }
      );
    }
    throw error;
  }
}

function requiresRemoteDebuggerTunnel(iosVersion?: string): boolean {
  const major = Number.parseInt(String(iosVersion ?? "").split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 18;
}

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}
