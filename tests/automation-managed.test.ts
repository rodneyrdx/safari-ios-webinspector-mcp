import { describe, expect, test, vi } from "vitest";
import { AutomationManagedManager, AutomationManagedSession } from "../src/services/automation-managed.js";
import type { DeviceInfo } from "../src/types.js";

describe("automation managed backend", () => {
  test("reports managed Automation capabilities and maps core requests", async () => {
    const connection = new FakeAutomationConnection();
    const session = new AutomationManagedSession(connection, "page-1", () => undefined);

    await expect(session.initializeCapabilities()).resolves.toMatchObject({
      backend: "automation_shim_managed",
      runtimeEval: true,
      console: false,
      network: false,
      domSnapshot: true,
      domActions: true,
      screenshot: true,
      uiRecovery: false
    });

    await expect(session.evaluate("1 + 1")).resolves.toEqual({ value: 2 });
    await expect(session.request("Page.navigate", { url: "https://example.com" })).resolves.toEqual({});
    await expect(session.request("Page.goBack")).resolves.toEqual({});
    await expect(session.request("Page.goForward")).resolves.toEqual({});
    await expect(session.request("Page.reload")).resolves.toEqual({});
    await expect(session.request("Page.captureScreenshot")).resolves.toEqual({ data: "ZmFrZS1pbWFnZQ==" });

    expect(connection.calls).toEqual([
      ["evaluate", "page-1", "1 + 1"],
      ["navigate", "page-1", "https://example.com"],
      ["back", "page-1"],
      ["forward", "page-1"],
      ["reload", "page-1"],
      ["screenshot", "page-1"]
    ]);
  });

  test("creates a managed Automation page through the manager", async () => {
    const connection = new FakeAutomationConnection();
    const manager = new AutomationManagedManager(5000);
    const result = await manager.createManagedSession(
      defaultDevice(),
      "https://example.com",
      () => undefined,
      async () => connection
    );

    expect(result.page).toMatchObject({
      backendHint: "automation_shim_managed",
      pageId: "automation-page-1",
      url: "https://example.com/",
      title: "Example Domain"
    });
    expect(result.capabilities.backend).toBe("automation_shim_managed");
    expect(connection.calls).toEqual([
      ["create"],
      ["navigate", "page-1", "https://example.com"],
      ["url", "page-1"],
      ["title", "page-1"]
    ]);
  });

  test("disposes the Automation session by closing the browsing context", async () => {
    const connection = new FakeAutomationConnection();
    const session = new AutomationManagedSession(connection, "page-1", () => undefined);
    session.dispose();
    await vi.waitFor(() => {
      expect(connection.calls).toContainEqual(["closeContext", "page-1"]);
      expect(connection.calls).toContainEqual(["close"]);
    });
  });
});

class FakeAutomationConnection {
  readonly calls: Array<unknown[]> = [];

  async createBrowsingContext() {
    this.calls.push(["create"]);
    return { handle: "page-1", presentation: "Window" as const };
  }

  async navigate(handle: string, url: string) {
    this.calls.push(["navigate", handle, url]);
  }

  async goBack(handle: string) {
    this.calls.push(["back", handle]);
  }

  async goForward(handle: string) {
    this.calls.push(["forward", handle]);
  }

  async reload(handle: string) {
    this.calls.push(["reload", handle]);
  }

  async evaluateExpression(handle: string, expression: string) {
    this.calls.push(["evaluate", handle, expression]);
    if (expression === "1 + 1") {
      return 2;
    }
    if (expression === "location.href") {
      return "https://example.com/";
    }
    if (expression === "document.title") {
      return "Example Domain";
    }
    return true;
  }

  async currentUrl(handle: string) {
    this.calls.push(["url", handle]);
    return "https://example.com/";
  }

  async title(handle: string) {
    this.calls.push(["title", handle]);
    return "Example Domain";
  }

  async takeScreenshot(handle: string) {
    this.calls.push(["screenshot", handle]);
    return "ZmFrZS1pbWFnZQ==";
  }

  async closeBrowsingContext(handle: string) {
    this.calls.push(["closeContext", handle]);
  }

  async deleteSession() {
    this.calls.push(["closeSession"]);
  }

  async close() {
    this.calls.push(["close"]);
  }
}

function defaultDevice(): DeviceInfo {
  return {
    deviceId: "physical:00000000-0000000000000000",
    displayName: "Test iPhone",
    port: 0,
    physicalId: "00000000-0000000000000000",
    browserFamily: "webkit",
    iosVersion: "26.3.1",
    inspectable: false
  };
}
