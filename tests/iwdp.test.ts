import { afterEach, describe, expect, test, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { IwdpManager, parseDeviceList, parsePageList, portFromDeviceId } from "../src/services/iwdp.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("iwdp parsers", () => {
  test("parses device HTML listing", () => {
    const html = `
      <html>
        <body>
          <a href="http://localhost:9222">Test iPhone</a>
          <a href="http://localhost:9223">QA device</a>
        </body>
      </html>
    `;

    expect(parseDeviceList(html)).toEqual([
      { displayName: "Test iPhone", port: 9222 },
      { displayName: "QA device", port: 9223 }
    ]);
  });

  test("parses page JSON listing", () => {
    const json = JSON.stringify([
      {
        id: "page-1",
        title: "Game",
        url: "https://example.com",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1"
      }
    ]);

    expect(parsePageList(json)).toEqual([
      {
        id: "page-1",
        title: "Game",
        url: "https://example.com",
        browserName: "Safari",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
        devtoolsFrontendUrl: undefined,
        raw: {
          id: "page-1",
          title: "Game",
          url: "https://example.com",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1"
        }
      }
    ]);
  });

  test("extracts port from device id", () => {
    expect(portFromDeviceId("ios-9222")).toBe(9222);
  });

  test("reuses an already healthy external bridge", async () => {
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
    const manager = new IwdpManager(defaultConfig());

    const status = await manager.ensureStarted();

    expect(status.running).toBe(true);
    expect(status.pid).toBeUndefined();
    expect(status.notes).toContain("Bridge health is currently being served by an external ios_webkit_debug_proxy process.");
  });
});

function defaultConfig(): AppConfig {
  return {
    cacheDir: "/tmp/swi-test-cache",
    bundleDir: "/tmp/swi-test-cache/bundles",
    bridgeCommand: "ios_webkit_debug_proxy",
    bridgeArgs: [],
    bridgeHost: "127.0.0.1",
    deviceListPort: 9221,
    firstDevicePort: 9222,
    wsRequestTimeoutMs: 5000,
    uiAutomationTimeoutMs: 4000,
    webDriverCommand: "safaridriver",
    webDriverPort: 4445
  };
}
