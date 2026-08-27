export type ToolErrorCode =
  | "dependency_missing"
  | "device_unavailable"
  | "page_not_found"
  | "not_attached"
  | "page_crashed"
  | "unsupported"
  | "timeout"
  | "invalid_input"
  | "bridge_unhealthy"
  | "internal_error";

export interface CommandStatus {
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  notes?: string[];
}

export interface EnvironmentCheckResult {
  platform: string;
  macosVersion?: string;
  xcodeDeveloperPath?: string;
  commands: CommandStatus[];
  connectedDevices: string[];
  safariInstalled: boolean;
  transportReadiness: {
    iwdpEvidence: boolean;
    webdriver: boolean;
    remoteDebugger: boolean;
    iphoneMirroring: boolean;
  };
  safeMode: {
    browserOnly: true;
    forbiddenOperations: string[];
  };
  recommendations: string[];
}

export interface BridgeStatus {
  running: boolean;
  pid?: number;
  startedAt?: string;
  basePort: number;
  deviceListPort: number;
  notes: string[];
  recentLogs: string[];
}

export interface DeviceInfo {
  deviceId: string;
  displayName: string;
  port: number;
  physicalId?: string;
  browserFamily: "webkit";
  iosVersion?: string;
  inspectable: boolean;
}

export type SessionBackend =
  | "iwdp_websocket"
  | "webdriver_managed"
  | "automation_shim_managed"
  | "remote_debugger_attached"
  | "ui_fallback";

export type SessionKind = "managed_page" | "attached_page";

export interface PageInfo {
  deviceId: string;
  pageId: string;
  port: number;
  title: string;
  url: string;
  browserName: string;
  backendHint?: SessionBackend;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  raw: Record<string, unknown>;
}

export interface SessionCapabilities {
  backend: SessionBackend;
  runtimeEval: boolean;
  console: boolean;
  network: boolean;
  domSnapshot: boolean;
  domActions: boolean;
  screenshot: boolean;
  uiRecovery: boolean;
  transportMode: "direct" | "brokered" | "broker_only";
  notes: string[];
}

export interface SessionProtocol {
  readonly id: string;
  waitUntilOpen(): Promise<void>;
  initializeCapabilities(): Promise<SessionCapabilities>;
  evaluate(expression: string): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getConsoleMessages(): ConsoleMessage[];
  getNetworkRequests(): NetworkRequestRecord[];
  isClosed(): boolean;
  close(): void;
  dispose(): void;
}

export interface ConsoleMessage {
  timestamp: string;
  level: "log" | "info" | "warning" | "error";
  text: string;
  source?: string;
  method?: string;
}

export interface NetworkRequestRecord {
  id: string;
  timestamp: string;
  url: string;
  method?: string;
  status?: number;
  mimeType?: string;
  resourceType?: string;
}

export interface CrashState {
  crashed: boolean;
  reason: string;
  detectedAt?: string;
  visibleInspectorCrash: boolean;
  visibleTitles: string[];
  websocketClosed: boolean;
}

export interface SessionState {
  sessionId: string;
  attached: boolean;
  sessionKind: SessionKind;
  deviceId: string;
  pageId: string;
  pageUrl: string;
  browserName: string;
  iosVersion?: string;
  capabilities: SessionCapabilities;
  consoleCount: number;
  networkCount: number;
  crashed: boolean;
  lastActivityAt: string;
}

export interface AttachedSession {
  sessionId: string;
  sessionKind: SessionKind;
  device: DeviceInfo;
  page: PageInfo;
  capabilities: SessionCapabilities;
  createdAt: string;
  lastActivityAt: string;
  websocketClosed: boolean;
  crash?: CrashState;
}

export interface DomNodeSnapshot {
  ref: string;
  tag: string;
  text: string;
  id?: string;
  className?: string;
  role?: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DebugBundleResult {
  bundleDir: string;
  files: string[];
}

export interface ParsedDevicePort {
  displayName: string;
  port: number;
}

export interface ParsedPageDescriptor {
  id: string;
  title: string;
  url: string;
  browserName: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
  raw: Record<string, unknown>;
}
