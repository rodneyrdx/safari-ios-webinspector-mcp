import { describe, expect, test } from "vitest";
import { recoverProtocolBinding } from "../src/services/recovery.js";
import { SessionStore } from "../src/services/session-store.js";
import type {
  DeviceInfo,
  PageInfo,
  SessionCapabilities,
  SessionProtocol
} from "../src/types.js";

class MockProtocol implements SessionProtocol {
  constructor(
    readonly id: string,
    private readonly closed = false
  ) {}

  disposed = false;

  async waitUntilOpen(): Promise<void> {}

  async initializeCapabilities(): Promise<SessionCapabilities> {
    return defaultCapabilities();
  }

  async evaluate(): Promise<unknown> {
    return { value: true };
  }

  async request(): Promise<Record<string, unknown>> {
    return {};
  }

  getConsoleMessages() {
    return [];
  }

  getNetworkRequests() {
    return [];
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.disposed = true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

describe("recovery", () => {
  test("rebinds a rediscovered page without triggering a stale crash", async () => {
    const store = new SessionStore();
    const device = defaultDevice();
    const originalPage = defaultPage("page-1", "ws://localhost/original");
    const replacementPage = defaultPage("page-1", "ws://localhost/replacement");
    const originalProtocol = new MockProtocol("protocol-1");
    const replacementProtocol = new MockProtocol("protocol-2");

    store.add("session-1", "attached_page", device, originalPage, defaultCapabilities(), originalProtocol);
    store.markCrashed("session-1", "protocol-1", "original crashed");
    store.rebind("session-1", replacementPage, defaultCapabilities(), replacementProtocol);
    store.markCrashed("session-1", "protocol-1", "late close from stale protocol");

    expect(originalProtocol.disposed).toBe(true);
    expect(store.get("session-1").page.webSocketDebuggerUrl).toBe("ws://localhost/replacement");
    expect(store.get("session-1").crash).toBeUndefined();
  });

  test("reconnects after UI reload when rediscovery initially fails", async () => {
    const originalPage = defaultPage("page-1", "ws://localhost/original");
    const reloadedPage = defaultPage("page-2", "ws://localhost/reloaded");
    const reboundProtocol = new MockProtocol("protocol-2");
    let attempts = 0;

    const result = await recoverProtocolBinding("session-1", originalPage, {
      listPages: async () => {
        attempts += 1;
        return attempts === 1 ? [] : [reloadedPage];
      },
      reconnectToPage: async () => ({
        page: reloadedPage,
        protocol: reboundProtocol,
        capabilities: defaultCapabilities()
      }),
      attemptReload: async () => ({ attempted: true }),
      wait: async () => undefined
    });

    expect(result).toMatchObject({
      recovered: true,
      method: "ui-reload-and-rebind",
      page: reloadedPage,
      protocol: reboundProtocol,
      reloadAttempt: { attempted: true }
    });
  });
});

function defaultCapabilities(): SessionCapabilities {
  return {
    backend: "iwdp_websocket",
    runtimeEval: true,
    console: true,
    network: true,
    domSnapshot: true,
    domActions: true,
    screenshot: true,
    uiRecovery: true,
    transportMode: "direct",
    notes: []
  };
}

function defaultDevice(): DeviceInfo {
  return {
    deviceId: "ios-9222",
    displayName: "Test iPhone",
    port: 9222,
    browserFamily: "webkit",
    inspectable: true
  };
}

function defaultPage(pageId: string, webSocketDebuggerUrl: string): PageInfo {
  return {
    deviceId: "ios-9222",
    pageId,
    port: 9222,
    title: "Game",
    url: "https://example.com",
    browserName: "Safari",
    backendHint: "iwdp_websocket",
    webSocketDebuggerUrl,
    raw: {}
  };
}
