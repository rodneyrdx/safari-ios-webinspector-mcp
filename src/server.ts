import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import { getConfig } from "./config.js";
import { ToolError } from "./errors.js";
import { checkEnvironment } from "./services/environment.js";
import { listTrustedDevices } from "./services/device-discovery.js";
import { attachWithAppiumRemoteDebugger } from "./services/appium-remote-debugger.js";
import { IwdpManager } from "./services/iwdp.js";
import { ProtocolSession } from "./services/protocol-session.js";
import { SafariDriverManager, writeWebDriverScreenshot } from "./services/safaridriver.js";
import { AutomationManagedManager } from "./services/automation-managed.js";
import { SessionStore } from "./services/session-store.js";
import { UiFallback } from "./services/ui-fallback.js";
import {
  clickElement,
  fillElement,
  getDomSnapshot,
  goBack,
  goForward,
  navigate,
  pressKey,
  reload,
  waitForText
} from "./services/dom-tools.js";
import { defaultRecoveryWait, recoverProtocolBinding } from "./services/recovery.js";
import { exportDebugBundle } from "./services/debug-bundle.js";
import { ensureDir, timestampId } from "./utils/fs.js";
import type { CrashState, DeviceInfo, PageInfo, SessionProtocol } from "./types.js";

const config = getConfig();
const iwdp = new IwdpManager(config);
const safariDriver = new SafariDriverManager(config);
const automationManager = new AutomationManagedManager(config.wsRequestTimeoutMs);
const sessions = new SessionStore();
const uiFallback = new UiFallback();

const tools: Tool[] = [
  tool("check_environment", "Inspect local macOS and iPhone debugging prerequisites."),
  tool("start_bridge", "Start or reuse ios_webkit_debug_proxy."),
  tool("stop_bridge", "Stop ios_webkit_debug_proxy."),
  tool("list_devices", "List connected iPhone WebKit devices."),
  tool("list_pages", "List inspectable pages for a device.", {
    type: "object",
    required: ["deviceId"],
    properties: {
      deviceId: { type: "string" }
    }
  }),
  tool("attach_page", "Attach to a page and create a live session.", {
    type: "object",
    required: ["deviceId", "pageId"],
    properties: {
      deviceId: { type: "string" },
      pageId: { type: "string" }
    }
  }),
  tool("launch_managed_page", "Launch a fresh Safari WebDriver session on the iPhone and navigate to a URL.", {
    type: "object",
    required: ["deviceId", "url"],
    properties: {
      deviceId: { type: "string" },
      url: { type: "string" }
    }
  }),
  tool("launch_automation_page", "Launch a fresh iPhone Safari Automation-domain session and navigate to a URL.", {
    type: "object",
    required: ["deviceId", "url"],
    properties: {
      deviceId: { type: "string" },
      url: { type: "string" }
    }
  }),
  tool("detach_page", "Detach an existing page session.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("get_session_state", "List all active session states."),
  tool("evaluate_script", "Execute JavaScript in the attached page.", {
    type: "object",
    required: ["sessionId", "expression"],
    properties: {
      sessionId: { type: "string" },
      expression: { type: "string" }
    }
  }),
  tool("get_console_messages", "Return buffered console output.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("get_network_requests", "Return buffered network requests.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("get_dom_snapshot", "Return a DOM snapshot with snapshot-scoped refs.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("click_element", "Click a DOM element reference from the latest snapshot.", {
    type: "object",
    required: ["sessionId", "ref"],
    properties: {
      sessionId: { type: "string" },
      ref: { type: "string" }
    }
  }),
  tool("fill_element", "Fill a DOM element value.", {
    type: "object",
    required: ["sessionId", "ref", "value"],
    properties: {
      sessionId: { type: "string" },
      ref: { type: "string" },
      value: { type: "string" }
    }
  }),
  tool("press_key", "Dispatch a key press to the active element.", {
    type: "object",
    required: ["sessionId", "key"],
    properties: {
      sessionId: { type: "string" },
      key: { type: "string" }
    }
  }),
  tool("navigate", "Navigate the page to a URL.", {
    type: "object",
    required: ["sessionId", "url"],
    properties: {
      sessionId: { type: "string" },
      url: { type: "string" }
    }
  }),
  tool("go_back", "Navigate backward in page history.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("go_forward", "Navigate forward in page history.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("reload", "Reload the page.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("wait_for_text", "Wait for body text to appear in the page.", {
    type: "object",
    required: ["sessionId", "text"],
    properties: {
      sessionId: { type: "string" },
      text: { type: "string" },
      timeoutMs: { type: "number" }
    }
  }),
  tool("take_screenshot", "Capture a session screenshot when supported, otherwise capture host-side evidence.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("get_crash_state", "Report websocket and visible Safari crash state.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("recover_session", "Attempt protocol reconnect and UI fallback recovery.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  }),
  tool("export_debug_bundle", "Write a structured debug bundle to the local cache directory.", {
    type: "object",
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" }
    }
  })
];

export async function startServer(): Promise<void> {
  await ensureDir(config.cacheDir);
  await ensureDir(config.bundleDir);

  const server = new Server(
    {
      name: "safari-ios-webinspector",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(request.params.name, request.params.arguments ?? {});
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "check_environment":
      return checkEnvironment();
    case "start_bridge":
      return iwdp.ensureStarted();
    case "stop_bridge":
      return iwdp.stop();
    case "list_devices":
      return iwdp.listDevices();
    case "list_pages":
      return iwdp.listPages(asString(args.deviceId, "deviceId"));
    case "attach_page":
      return attachPage(asString(args.deviceId, "deviceId"), asString(args.pageId, "pageId"));
    case "launch_managed_page":
      return launchManagedPage(asString(args.deviceId, "deviceId"), asString(args.url, "url"));
    case "launch_automation_page":
      return launchAutomationPage(asString(args.deviceId, "deviceId"), asString(args.url, "url"));
    case "detach_page":
      sessions.remove(asString(args.sessionId, "sessionId"));
      return { detached: true };
    case "get_session_state":
      return sessions.listStates();
    case "evaluate_script": {
      const protocol = getProtocol(args);
      const value = await protocol.evaluate(asString(args.expression, "expression"));
      sessions.touch(asString(args.sessionId, "sessionId"));
      return value;
    }
    case "get_console_messages":
      return sessions.getConsoleMessages(asString(args.sessionId, "sessionId"));
    case "get_network_requests":
      return sessions.getNetworkRequests(asString(args.sessionId, "sessionId"));
    case "get_dom_snapshot":
      return getDomSnapshot(getProtocol(args));
    case "click_element":
      return clickElement(getProtocol(args), asString(args.ref, "ref"));
    case "fill_element":
      return fillElement(getProtocol(args), asString(args.ref, "ref"), asString(args.value, "value"));
    case "press_key":
      return pressKey(getProtocol(args), asString(args.key, "key"));
    case "navigate":
      return navigate(getProtocol(args), asString(args.url, "url"));
    case "go_back":
      return goBack(getProtocol(args));
    case "go_forward":
      return goForward(getProtocol(args));
    case "reload":
      return reload(getProtocol(args));
    case "wait_for_text":
      return waitForText(
        getProtocol(args),
        asString(args.text, "text"),
        typeof args.timeoutMs === "number" ? args.timeoutMs : 5000
      );
    case "take_screenshot":
      return takeScreenshot(asString(args.sessionId, "sessionId"));
    case "get_crash_state":
      return getCrashState(asString(args.sessionId, "sessionId"));
    case "recover_session":
      return recoverSession(asString(args.sessionId, "sessionId"));
    case "export_debug_bundle":
      return exportBundle(asString(args.sessionId, "sessionId"));
    default:
      throw new ToolError("invalid_input", `Unknown tool ${name}.`);
  }
}

async function attachPage(deviceId: string, pageId: string) {
  const device = (await iwdp.listDevices()).find((item) => item.deviceId === deviceId);
  if (!device) {
    throw new ToolError("device_unavailable", `No device found for ${deviceId}.`);
  }
  const page = (await iwdp.listPages(deviceId)).find((item) => item.pageId === pageId);
  if (!page) {
    throw new ToolError("page_not_found", `No page found for ${pageId} on ${deviceId}.`);
  }
  if (!page.webSocketDebuggerUrl) {
    throw new ToolError("unsupported", "This page does not expose a websocket debugger URL.");
  }

  const sessionId = randomUUID();
  const { page: attachedPage, protocol, capabilities } = await connectAttachedSession(sessionId, device, page);
  const attached = sessions.add(sessionId, "attached_page", device, attachedPage, capabilities, protocol);
  return attached;
}

async function launchManagedPage(deviceId: string, url: string) {
  const device = await resolveManagedDevice(deviceId);
  const sessionId = randomUUID();
  const { page, protocol, capabilities } = await safariDriver.createManagedSession(device, url, ({ protocolId, reason }) => {
    sessions.markCrashed(sessionId, protocolId, reason);
  });
  return sessions.add(sessionId, "managed_page", device, page, capabilities, protocol);
}

async function launchAutomationPage(deviceId: string, url: string) {
  const device = await resolveManagedDevice(deviceId);
  const sessionId = randomUUID();
  const { page, protocol, capabilities } = await automationManager.createManagedSession(device, url, ({ protocolId, reason }) => {
    sessions.markCrashed(sessionId, protocolId, reason);
  });
  return sessions.add(sessionId, "managed_page", device, page, capabilities, protocol);
}

function getProtocol(args: Record<string, unknown>): SessionProtocol {
  const sessionId = asString(args.sessionId, "sessionId");
  return sessions.getProtocol(sessionId);
}

async function takeScreenshot(sessionId: string) {
  const screenshotPath = path.join(config.cacheDir, `${timestampId()}-${sessionId}.png`);
  const attached = sessions.get(sessionId);
  const protocol = sessions.getProtocol(sessionId);
  if (attached.capabilities.backend === "webdriver_managed") {
    const captured = await writeWebDriverScreenshot(protocol, screenshotPath);
    if (captured) {
      return { screenshotPath, source: "session" };
    }
  } else if (attached.capabilities.backend === "automation_shim_managed") {
    const result = await protocol.request("Page.captureScreenshot").catch(() => null);
    const data = result && typeof result.data === "string" ? result.data : undefined;
    if (typeof data === "string" && data.length > 0) {
      await import("node:fs/promises").then((fs) => fs.writeFile(screenshotPath, Buffer.from(data, "base64")));
      return { screenshotPath, source: "session" };
    }
  } else if (attached.capabilities.backend === "remote_debugger_attached") {
    const result = await protocol.request("Page.captureScreenshot").catch(() => null);
    const data = result && typeof result.data === "string" ? result.data : undefined;
    if (typeof data === "string" && data.length > 0) {
      await import("node:fs/promises").then((fs) => fs.writeFile(screenshotPath, Buffer.from(data, "base64")));
      return { screenshotPath, source: "session" };
    }
  }

  await uiFallback.takeHostScreenshot(screenshotPath);
  return { screenshotPath, source: "host" };
}

async function getCrashState(sessionId: string): Promise<CrashState> {
  const attached = sessions.get(sessionId);
  const visible = await uiFallback.getVisibleCrashState();
  const websocketClosed = sessions.getProtocol(sessionId).isClosed();
  const crashState: CrashState = {
    crashed: websocketClosed || visible.visibleInspectorCrash || Boolean(attached.crash?.crashed),
    reason: attached.crash?.reason ?? (visible.visibleInspectorCrash
      ? "Visible Safari Web Inspector crash window detected."
      : websocketClosed
        ? "The page websocket closed unexpectedly."
        : "No crash detected."),
    detectedAt: attached.crash?.detectedAt,
    visibleInspectorCrash: visible.visibleInspectorCrash,
    visibleTitles: visible.visibleTitles,
    websocketClosed
  };
  sessions.setCrashState(sessionId, crashState);
  return crashState;
}

async function recoverSession(sessionId: string) {
  const attached = sessions.get(sessionId);
  const currentState = await getCrashState(sessionId);
  if (!currentState.crashed) {
    return { recovered: true, method: "no-op", state: currentState };
  }

  if (attached.sessionKind === "managed_page") {
    return {
      recovered: false,
      method: "unsupported-managed-session",
      state: currentState,
      notes: [
        "Managed Safari automation sessions are isolated from normal browsing tabs.",
        "Relaunch the managed session instead of trying to rebind a crashed browser tab."
      ]
    };
  }

  const outcome = await recoverProtocolBinding(sessionId, attached.page, {
    listPages: async (deviceId) => iwdp.listPages(deviceId),
    reconnectToPage: async (rebindSessionId, page) => connectAttachedSession(rebindSessionId, attached.device, page),
    attemptReload: async () => uiFallback.attemptReloadViaKeyboard(),
    wait: defaultRecoveryWait
  });

  if (outcome.recovered && outcome.page && outcome.protocol && outcome.capabilities) {
    sessions.rebind(sessionId, outcome.page, outcome.capabilities, outcome.protocol);
  }

  return {
    recovered: outcome.recovered,
    method: outcome.method,
    state: await getCrashState(sessionId),
    reloadAttempt: outcome.reloadAttempt,
    page: outcome.page
  };
}

async function resolveManagedDevice(deviceId: string): Promise<DeviceInfo> {
  try {
    const bridgeDevice = (await iwdp.listDevices()).find((item) => item.deviceId === deviceId || item.physicalId === deviceId);
    if (bridgeDevice?.physicalId) {
      return bridgeDevice;
    }
  } catch {
    // Managed sessions can still work without the iwdp bridge.
  }

  const trustedDevices = await listTrustedDevices();
  const matched = trustedDevices.find((item) =>
    item.udid === deviceId || item.displayName.toLowerCase() === deviceId.toLowerCase()
  );

  if (matched) {
    return {
      deviceId: `physical:${matched.udid}`,
      displayName: matched.displayName,
      port: 0,
      physicalId: matched.udid,
      browserFamily: "webkit",
      iosVersion: matched.iosVersion,
      inspectable: false
    };
  }

  if (trustedDevices.length === 1) {
    const [single] = trustedDevices;
    return {
      deviceId: `physical:${single.udid}`,
      displayName: single.displayName,
      port: 0,
      physicalId: single.udid,
      browserFamily: "webkit",
      iosVersion: single.iosVersion,
      inspectable: false
    };
  }

  throw new ToolError("device_unavailable", `No trusted iPhone matched ${deviceId} for managed Safari automation.`);
}

async function connectProtocol(sessionId: string, page: PageInfo) {
  if (!page.webSocketDebuggerUrl) {
    throw new ToolError("unsupported", "This page does not expose a websocket debugger URL.");
  }

  const protocol = new ProtocolSession(page.webSocketDebuggerUrl, config.wsRequestTimeoutMs, ({ protocolId, reason }) => {
    sessions.markCrashed(sessionId, protocolId, reason);
  });
  await protocol.waitUntilOpen();
  const capabilities = await protocol.initializeCapabilities();
  return { page, protocol, capabilities };
}

async function connectAttachedSession(sessionId: string, device: DeviceInfo, page: PageInfo) {
  const appiumResult = await tryConnectAppium(sessionId, device, page);
  if (appiumResult) {
    return appiumResult;
  }
  return connectProtocol(sessionId, page);
}

async function tryConnectAppium(sessionId: string, device: DeviceInfo, page: PageInfo) {
  if (!device.physicalId) {
    return null;
  }

  try {
    return await attachWithAppiumRemoteDebugger(device, page, ({ protocolId, reason }) => {
      sessions.markCrashed(sessionId, protocolId, reason);
    });
  } catch {
    return null;
  }
}

async function exportBundle(sessionId: string) {
  const attached = sessions.get(sessionId);
  const crashState = await getCrashState(sessionId);
  const screenshot = await takeScreenshot(sessionId);
  return exportDebugBundle(
    config.bundleDir,
    attached,
    sessions.getConsoleMessages(sessionId),
    sessions.getNetworkRequests(sessionId),
    crashState,
    screenshot.screenshotPath
  );
}

type ToolInputSchema = {
  type: "object";
  properties?: Record<string, object>;
  required?: string[];
};

function tool(name: string, description: string, inputSchema: ToolInputSchema = { type: "object", properties: {} }): Tool {
  return { name, description, inputSchema };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError("invalid_input", `${field} must be a non-empty string.`);
  }
  return value;
}

function textResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof ToolError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ok: false,
              code: error.code,
              message: error.message,
              details: error.details ?? null
            },
            null,
            2
          )
        }
      ]
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: false,
            code: "internal_error",
            message: error instanceof Error ? error.message : String(error)
          },
          null,
          2
        )
      }
    ]
  };
}
