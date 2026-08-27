import { describe, expect, test } from "vitest";
import { attachWithAppiumRemoteDebugger, type RemoteDebuggerLike } from "../src/services/appium-remote-debugger.js";
import type { DeviceInfo, PageInfo } from "../src/types.js";

describe("appium remote debugger backend", () => {
  test("attaches to a matching Safari page and exposes session capabilities", async () => {
    const fake = new FakeRemoteDebugger();
    const result = await attachWithAppiumRemoteDebugger(
      defaultDevice(),
      defaultPage(),
      () => undefined,
      async () => fake
    );

    expect(fake.selectedPage).toEqual({
      appIdKey: "PID:1",
      pageIdKey: "page-1",
      skipReadyCheck: false
    });
    expect(result.page.backendHint).toBe("remote_debugger_attached");
    expect(result.capabilities).toMatchObject({
      backend: "remote_debugger_attached",
      runtimeEval: true,
      console: true,
      network: true,
      domSnapshot: true,
      domActions: true,
      screenshot: true
    });
    await expect(result.protocol.evaluate("1 + 1")).resolves.toEqual({ value: 2 });
    await expect(result.protocol.request("Page.captureScreenshot")).resolves.toEqual({
      data: "ZmFrZS1pbWFnZQ=="
    });

    fake.emitConsole({ message: "hello", level: "warning" }, "Console.messageAdded");
    fake.emitNetwork({ requestId: "req-1", request: { url: "https://example.com", method: "GET" } }, "Network.requestWillBeSent");

    expect(result.protocol.getConsoleMessages()).toHaveLength(1);
    expect(result.protocol.getNetworkRequests()).toHaveLength(1);
  });

  test("requires a physical device id", async () => {
    await expect(
      attachWithAppiumRemoteDebugger(
        {
          ...defaultDevice(),
          physicalId: undefined
        },
        defaultPage(),
        () => undefined,
        async () => new FakeRemoteDebugger()
      )
    ).rejects.toThrow("physical iPhone UDID");
  });

  test("fails fast with a shim-specific limitation when existing-tab selection never completes", async () => {
    await expect(
      attachWithAppiumRemoteDebugger(
        defaultDevice(),
        defaultPage(),
        () => undefined,
        async () => new HangingShimRemoteDebugger(),
        { selectPageTimeoutMs: 25 }
      )
    ).rejects.toThrow("isolated Automation-only shim surface");
  });
});

class FakeRemoteDebugger implements RemoteDebuggerLike {
  readonly appDict: Record<string, { pageArray?: Array<{ id: string; url: string; title: string; isKey: boolean }> }> = {};
  readonly useWebInspectorShim = true;
  _appIdKey?: string | number;
  selectedPage?: { appIdKey: string | number; pageIdKey: string | number; skipReadyCheck?: boolean };
  private consoleListener?: (error?: Error | null, event?: Record<string, unknown>, method?: string) => void;
  private networkListener?: (error?: Error | null, event?: Record<string, unknown>, method?: string) => void;

  async connect(): Promise<Record<string, unknown>> {
    return {
      "PID:1": {
        pageArray: [
          { id: "page-1", url: "https://example.com", title: "Game", isKey: true }
        ]
      }
    };
  }

  async disconnect(): Promise<void> {}

  async selectApp(): Promise<Array<{ id: string | number; url: string; title: string; isKey: boolean }>> {
    this._appIdKey = "PID:1";
    this.appDict["PID:1"] = {
      pageArray: [
        { id: "page-1", url: "https://example.com", title: "Game", isKey: true }
      ]
    };
    return [
      { id: "1.page-1", url: "https://example.com", title: "Game", isKey: true }
    ];
  }

  async selectPage(appIdKey: string | number, pageIdKey: string | number, skipReadyCheck?: boolean): Promise<void> {
    this.selectedPage = { appIdKey, pageIdKey, skipReadyCheck };
  }

  async execute(command: string): Promise<unknown> {
    if (command === "1 + 1") {
      return 2;
    }
    return true;
  }

  async captureScreenshot(): Promise<string> {
    return "ZmFrZS1pbWFnZQ==";
  }

  startConsole(listener: (error?: Error | null, event?: Record<string, unknown>, method?: string) => void): void {
    this.consoleListener = listener;
  }

  stopConsole(): void {
    this.consoleListener = undefined;
  }

  startNetwork(listener: (error?: Error | null, event?: Record<string, unknown>, method?: string) => void): void {
    this.networkListener = listener;
  }

  stopNetwork(): void {
    this.networkListener = undefined;
  }

  emitConsole(event: Record<string, unknown>, method?: string): void {
    this.consoleListener?.(null, event, method);
  }

  emitNetwork(event: Record<string, unknown>, method?: string): void {
    this.networkListener?.(null, event, method);
  }
}

class HangingShimRemoteDebugger extends FakeRemoteDebugger {
  override async selectPage(): Promise<void> {
    await new Promise(() => undefined);
  }
}

function defaultDevice(): DeviceInfo {
  return {
    deviceId: "ios-9222",
    displayName: "Test iPhone",
    port: 9222,
    physicalId: "00000000-0000000000000000",
    browserFamily: "webkit",
    iosVersion: "26.3.1",
    inspectable: true
  };
}

function defaultPage(): PageInfo {
  return {
    deviceId: "ios-9222",
    pageId: "page-1",
    port: 9222,
    title: "Game",
    url: "https://example.com",
    browserName: "Safari",
    backendHint: "iwdp_websocket",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
    raw: {}
  };
}
