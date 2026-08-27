import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ToolError } from "../errors.js";
import type {
  AttachedSession,
  ConsoleMessage,
  NetworkRequestRecord,
  SessionProtocol,
  SessionCapabilities
} from "../types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface CloseNotice {
  protocolId: string;
  reason: string;
}

interface BrokerRoute {
  targetId: string;
  includePageProxyId: boolean;
  label: string;
  paused: boolean;
}

export class ProtocolSession implements SessionProtocol {
  readonly id = randomUUID();
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly brokerPending = new Map<number, PendingRequest>();
  private readonly consoleMessages: ConsoleMessage[] = [];
  private readonly networkRequests: NetworkRequestRecord[] = [];
  private requestId = 0;
  private brokerRequestId = 10_000;
  private closed = false;
  private notifyOnClose = true;
  private pageTargetId?: string;
  private frameTargetId?: string;
  private pageTargetPaused = false;
  private frameTargetPaused = false;
  private readonly capabilityNotes = new Set<string>();
  private transportMode: SessionCapabilities["transportMode"] = "direct";
  private readonly pageProxyId?: string;
  private brokerRoute?: BrokerRoute;

  constructor(
    private readonly websocketUrl: string,
    private readonly timeoutMs: number,
    private readonly onClosed: (notice: CloseNotice) => void
  ) {
    this.pageProxyId = parsePageProxyId(websocketUrl);
    this.ws = new WebSocket(websocketUrl);
    this.ws.on("message", (data) => this.handleMessage(String(data)));
    this.ws.on("close", (code, reason) => {
      this.closed = true;
      this.emitClosed(`websocket closed code=${code} reason=${String(reason)}`);
    });
    this.ws.on("error", (error) => {
      this.emitClosed(`websocket error: ${error.message}`);
    });
  }

  async waitUntilOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ToolError("timeout", "Timed out waiting for WebKit websocket.")), this.timeoutMs);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async initializeCapabilities(): Promise<SessionCapabilities> {
    const capabilities: SessionCapabilities = {
      backend: "iwdp_websocket",
      runtimeEval: false,
      console: false,
      network: false,
      domSnapshot: false,
      domActions: false,
      screenshot: false,
      uiRecovery: true,
      transportMode: "direct",
      notes: []
    };

    capabilities.runtimeEval = await this.tryRequest("Runtime.enable");
    if (capabilities.runtimeEval) {
      capabilities.domSnapshot = true;
      capabilities.domActions = true;
    }
    capabilities.console = await this.tryRequest("Console.enable");
    capabilities.network = await this.tryRequest("Network.enable");
    capabilities.screenshot = await this.tryRequest("Page.enable");

    if (!capabilities.runtimeEval && this.hasObservedTargetBroker()) {
      this.transportMode = await this.probeBrokeredMode(capabilities);
      capabilities.transportMode = this.transportMode;
      capabilities.notes = [...this.capabilityNotes];
      return capabilities;
    }

    capabilities.transportMode = this.transportMode;
    capabilities.notes = [...this.capabilityNotes];

    return capabilities;
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.request("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    const record = result as Record<string, unknown>;
    return unwrapEvaluationResult(record.result);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.transportMode === "brokered" && !isDirectTargetCommand(method)) {
      return this.requestViaTarget(method, params);
    }
    if (this.transportMode === "broker_only" && !isDirectTargetCommand(method)) {
      throw new ToolError("unsupported", "This iPhone page is exposing only the Target broker. Nested page-domain responses were not observed during capability probing.", {
        method,
        transportMode: this.transportMode,
        notes: [...this.capabilityNotes]
      });
    }
    if (this.closed) {
      throw new ToolError("not_attached", "The page websocket is already closed.");
    }

    const id = ++this.requestId;
    const payload = JSON.stringify({ id, method, params });
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("timeout", `WebKit request ${method} timed out.`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });

    const record = result as Record<string, unknown>;
    if (record.error) {
      throw new ToolError("unsupported", `WebKit request ${method} failed.`, {
        error: record.error
      });
    }
    return record;
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
    this.ws.close();
  }

  dispose(): void {
    this.notifyOnClose = false;
    if (this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      return;
    }
    this.ws.close();
  }

  private async tryRequest(method: string): Promise<boolean> {
    try {
      await this.request(method);
      return true;
    } catch {
      return false;
    }
  }

  private async requestViaTarget(
    method: string,
    params: Record<string, unknown>,
    route = this.brokerRoute ?? this.getBrokerRoutes()[0],
    nestedTimeoutMs = this.timeoutMs
  ): Promise<Record<string, unknown>> {
    if (!route) {
      throw new ToolError("unsupported", "No page target id is available for brokered protocol mode.", {
        method
      });
    }

    const nestedId = ++this.brokerRequestId;
    const message = JSON.stringify({ id: nestedId, method, params });

    const nestedResultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.brokerPending.delete(nestedId);
        reject(new ToolError("timeout", `Brokered WebKit request ${method} timed out.`));
      }, nestedTimeoutMs);

      this.brokerPending.set(nestedId, { resolve, reject, timer });
    });

    try {
      const targetParams: Record<string, unknown> = {
        targetId: route.targetId,
        message
      };
      if (route.includePageProxyId && this.pageProxyId) {
        targetParams.pageProxyId = this.pageProxyId;
      }

      await this.sendRawRequest("Target.sendMessageToTarget", targetParams);
      const result = await nestedResultPromise;
      return result as Record<string, unknown>;
    } catch (error) {
      const pending = this.brokerPending.get(nestedId);
      if (pending) {
        clearTimeout(pending.timer);
        this.brokerPending.delete(nestedId);
      }
      throw error;
    }
  }

  private async sendRawRequest(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new ToolError("not_attached", "The page websocket is already closed.");
    }

    const id = ++this.requestId;
    const payload = JSON.stringify({ id, method, params });
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("timeout", `WebKit request ${method} timed out.`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });

    const record = result as Record<string, unknown>;
    if (record.error) {
      throw new ToolError("unsupported", `WebKit request ${method} failed.`, {
        error: record.error
      });
    }
    return record;
  }

  private async probeBrokeredMode(capabilities: SessionCapabilities): Promise<SessionCapabilities["transportMode"]> {
    const routes = this.getBrokerRoutes();
    if (!routes.length) {
      this.capabilityNotes.add("Target broker events were observed, but no usable target route was captured.");
      return "broker_only";
    }

    this.capabilityNotes.add(
      `Target broker detected via ${routes.map((route) => route.label).join(", ")}.`
    );
    await this.tryEnablePauseOnStart();

    for (const route of routes) {
      const result = await this.tryBrokerInitialization(route);
      if (!result.runtimeEval && !result.console && !result.network && !result.screenshot) {
        continue;
      }

      this.brokerRoute = route;
      capabilities.runtimeEval = result.runtimeEval;
      capabilities.console = result.console;
      capabilities.network = result.network;
      capabilities.screenshot = result.screenshot;
      capabilities.domSnapshot = result.domSnapshot;
      capabilities.domActions = result.domActions;
      this.capabilityNotes.add(`Brokered page control enabled via ${route.label}.`);
      return "brokered";
    }

    this.capabilityNotes.add("Wrapped Target.sendMessageToTarget requests were acknowledged, but no nested page-domain responses were observed.");
    return "broker_only";
  }

  private async tryBrokeredRequest(
    method: string,
    params: Record<string, unknown>,
    route: BrokerRoute
  ): Promise<boolean> {
    try {
      await this.requestViaTarget(method, params, route, this.getBrokerProbeTimeoutMs());
      return true;
    } catch (error) {
      this.capabilityNotes.add(`Brokered probe failed for ${method} via ${route.label}: ${describeError(error)}`);
      return false;
    }
  }

  private async tryBrokerInitialization(route: BrokerRoute): Promise<Pick<SessionCapabilities, "runtimeEval" | "console" | "network" | "screenshot" | "domSnapshot" | "domActions">> {
    const result = {
      runtimeEval: false,
      console: false,
      network: false,
      screenshot: false,
      domSnapshot: false,
      domActions: false
    };

    try {
      result.screenshot = await this.tryBrokeredRequest("Inspector.enable", {}, route);
      result.screenshot = await this.tryBrokeredRequest("Page.enable", {}, route) || result.screenshot;
      const runtimeEnabled = await this.tryBrokeredRequest("Runtime.enable", {}, route);
      const evaluationWorked = runtimeEnabled
        ? await this.tryBrokeredEvaluation(route)
        : false;

      result.runtimeEval = runtimeEnabled && evaluationWorked;
      if (result.runtimeEval) {
        result.domSnapshot = true;
        result.domActions = true;
      }

      result.network = await this.tryBrokeredRequest("Network.enable", {}, route);
      await this.tryBrokeredRequest("Heap.enable", {}, route);
      await this.tryBrokeredRequest("Debugger.enable", {}, route);
      result.console = await this.tryBrokeredRequest("Console.enable", {}, route);
      await this.tryBrokeredRequest("Inspector.initialized", {}, route);
      return result;
    } finally {
      if (route.paused) {
        await this.tryResumeTarget(route.targetId);
      }
    }
  }

  private async tryBrokeredEvaluation(route: BrokerRoute): Promise<boolean> {
    try {
      const record = await this.requestViaTarget("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
        awaitPromise: true
      }, route, this.getBrokerProbeTimeoutMs());
      const value = unwrapEvaluationResult(record.result);
      this.capabilityNotes.add(`Brokered Runtime.evaluate succeeded via ${route.label}${formatEvaluationNote(value)}.`);
      return true;
    } catch (error) {
      this.capabilityNotes.add(`Brokered Runtime.evaluate failed via ${route.label}: ${describeError(error)}`);
      return false;
    }
  }

  private async tryEnablePauseOnStart(): Promise<void> {
    try {
      await this.sendRawRequest("Target.setPauseOnStart", { pauseOnStart: true });
      this.capabilityNotes.add("Target.setPauseOnStart succeeded before broker probing.");
    } catch (error) {
      this.capabilityNotes.add(`Target.setPauseOnStart failed: ${describeError(error)}`);
    }
  }

  private async tryResumeTarget(targetId: string): Promise<void> {
    try {
      await this.sendRawRequest("Target.resume", { targetId });
      this.capabilityNotes.add(`Target.resume succeeded for target ${targetId}.`);
    } catch (error) {
      this.capabilityNotes.add(`Target.resume failed for target ${targetId}: ${describeError(error)}`);
    }
  }

  private handleMessage(payload: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.pending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(parsed.id);
      pending.resolve(parsed);
      return;
    }

    const method = typeof parsed.method === "string" ? parsed.method : "";
    const params = typeof parsed.params === "object" && parsed.params !== null
      ? parsed.params as Record<string, unknown>
      : {};

    if (method === "Target.targetCreated") {
      this.captureTargetInfo(params);
    }

    if (method === "Target.dispatchMessageFromTarget") {
      this.handleBrokerDispatch(params);
      return;
    }

    if (method.includes("Console") || method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
      this.consoleMessages.push(normalizeConsoleMessage(method, params));
      trimArray(this.consoleMessages, 500);
    }

    if (method.startsWith("Network.")) {
      const networkRecord = normalizeNetworkEvent(method, params);
      if (networkRecord) {
        this.networkRequests.push(networkRecord);
        trimArray(this.networkRequests, 500);
      }
    }
  }

  private emitClosed(reason: string): void {
    if (!this.notifyOnClose) {
      return;
    }
    this.onClosed({
      protocolId: this.id,
      reason
    });
  }

  private captureTargetInfo(params: Record<string, unknown>): void {
    const targetInfo = typeof params.targetInfo === "object" && params.targetInfo !== null
      ? params.targetInfo as Record<string, unknown>
      : {};
    const targetId = typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
    const targetType = typeof targetInfo.type === "string" ? targetInfo.type : undefined;
    const paused = Boolean(targetInfo.isPaused);

    if (targetType === "page" && targetId) {
      this.pageTargetId = targetId;
      this.pageTargetPaused = paused;
      return;
    }
    if (targetType === "frame" && targetId) {
      this.frameTargetId = targetId;
      this.frameTargetPaused = paused;
    }
  }

  private handleBrokerDispatch(params: Record<string, unknown>): void {
    const message = typeof params.message === "string" ? params.message : undefined;
    if (!message) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(message) as Record<string, unknown>;
    } catch {
      this.capabilityNotes.add("Received a non-JSON Target.dispatchMessageFromTarget payload.");
      return;
    }

    if (typeof parsed.id === "number") {
      const pending = this.brokerPending.get(parsed.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.brokerPending.delete(parsed.id);
      if (parsed.error) {
        pending.reject(new ToolError("unsupported", "Brokered WebKit request failed.", {
          error: parsed.error
        }));
        return;
      }
      pending.resolve(parsed);
      return;
    }

    const nestedMethod = typeof parsed.method === "string" ? parsed.method : "";
    const nestedParams = typeof parsed.params === "object" && parsed.params !== null
      ? parsed.params as Record<string, unknown>
      : {};

    if (nestedMethod.includes("Console") || nestedMethod === "Runtime.consoleAPICalled" || nestedMethod === "Log.entryAdded") {
      this.consoleMessages.push(normalizeConsoleMessage(nestedMethod, nestedParams));
      trimArray(this.consoleMessages, 500);
    }

    if (nestedMethod.startsWith("Network.")) {
      const networkRecord = normalizeNetworkEvent(nestedMethod, nestedParams);
      if (networkRecord) {
        this.networkRequests.push(networkRecord);
        trimArray(this.networkRequests, 500);
      }
    }
  }

  private hasObservedTargetBroker(): boolean {
    return Boolean(this.pageTargetId || this.frameTargetId);
  }

  private getBrokerProbeTimeoutMs(): number {
    return Math.min(this.timeoutMs, 750);
  }

  private getBrokerRoutes(): BrokerRoute[] {
    const routes: BrokerRoute[] = [];
    const seen = new Set<string>();

    const pushRoute = (targetId: string | undefined, paused: boolean, source: "page" | "frame") => {
      if (!targetId) {
        return;
      }

      for (const includePageProxyId of [false, true]) {
        if (includePageProxyId && !this.pageProxyId) {
          continue;
        }
        const key = `${source}:${targetId}:${includePageProxyId ? "with-page-proxy" : "raw"}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        routes.push({
          targetId,
          includePageProxyId,
          paused,
          label: `${source} target ${targetId}${includePageProxyId && this.pageProxyId ? ` with pageProxyId ${this.pageProxyId}` : ""}`
        });
      }
    };

    pushRoute(this.pageTargetId, this.pageTargetPaused, "page");
    if (this.frameTargetId !== this.pageTargetId) {
      pushRoute(this.frameTargetId, this.frameTargetPaused, "frame");
    }
    return routes;
  }
}

function normalizeConsoleMessage(method: string, params: Record<string, unknown>): ConsoleMessage {
  if (method === "Runtime.consoleAPICalled") {
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args
      .map((entry) => {
        if (typeof entry !== "object" || entry === null) {
          return "";
        }
        const value = (entry as Record<string, unknown>).value;
        return value === undefined ? "" : String(value);
      })
      .filter(Boolean)
      .join(" ");

    return {
      timestamp: new Date().toISOString(),
      level: normalizeLevel(String(params.type ?? "log")),
      text,
      source: "Runtime",
      method
    };
  }

  const messageRecord = typeof params.message === "object" && params.message !== null
    ? params.message as Record<string, unknown>
    : params;

  return {
    timestamp: new Date().toISOString(),
    level: normalizeLevel(String(messageRecord.level ?? messageRecord.type ?? "log")),
    text: String(messageRecord.text ?? messageRecord.message ?? JSON.stringify(messageRecord)),
    source: String(messageRecord.source ?? "Console"),
    method
  };
}

function normalizeNetworkEvent(method: string, params: Record<string, unknown>): NetworkRequestRecord | undefined {
  if (method === "Network.requestWillBeSent") {
    const request = typeof params.request === "object" && params.request !== null
      ? params.request as Record<string, unknown>
      : {};
    return {
      id: String(params.requestId ?? randomUUID()),
      timestamp: new Date().toISOString(),
      url: String(request.url ?? ""),
      method: typeof request.method === "string" ? request.method : undefined,
      resourceType: typeof params.type === "string" ? params.type : undefined
    };
  }

  if (method === "Network.responseReceived") {
    const response = typeof params.response === "object" && params.response !== null
      ? params.response as Record<string, unknown>
      : {};
    return {
      id: String(params.requestId ?? randomUUID()),
      timestamp: new Date().toISOString(),
      url: String(response.url ?? ""),
      status: typeof response.status === "number" ? response.status : undefined,
      mimeType: typeof response.mimeType === "string" ? response.mimeType : undefined,
      resourceType: typeof params.type === "string" ? params.type : undefined
    };
  }

  return undefined;
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

export function buildRuntimeSessionState(
  attached: AttachedSession,
  protocolSession: ProtocolSession | undefined
): Pick<AttachedSession, "sessionId" | "device" | "page" | "capabilities"> {
  if (!protocolSession) {
    return attached;
  }
  return attached;
}

function parsePageProxyId(websocketUrl: string): string | undefined {
  const match = websocketUrl.match(/\/devtools\/page\/([^/?#]+)/);
  return match?.[1];
}

function isDirectTargetCommand(method: string): boolean {
  return method.startsWith("Target.");
}

function unwrapEvaluationResult(result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (record.result !== undefined) {
    return record.result;
  }
  return result;
}

function describeError(error: unknown): string {
  if (error instanceof ToolError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatEvaluationNote(value: unknown): string {
  if (typeof value === "string") {
    return ` (value=${value})`;
  }
  if (typeof value === "object" && value !== null && "value" in value) {
    return ` (value=${String((value as Record<string, unknown>).value)})`;
  }
  return "";
}
