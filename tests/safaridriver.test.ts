import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebDriverSession, writeWebDriverScreenshot } from "../src/services/safaridriver.js";

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("safaridriver session", () => {
  test("reports managed-session capabilities", async () => {
    const session = new WebDriverSession("http://127.0.0.1:4445", "webdriver-1", () => undefined);
    await expect(session.initializeCapabilities()).resolves.toMatchObject({
      backend: "webdriver_managed",
      runtimeEval: true,
      console: false,
      network: false,
      domSnapshot: true,
      domActions: true,
      screenshot: true,
      uiRecovery: false
    });
  });

  test("evaluates JavaScript through the WebDriver execute endpoint", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      return new Response(JSON.stringify({ value: { __swiKind: "json", json: "2" } }), { status: 200 });
    }) as typeof fetch;

    const session = new WebDriverSession("http://127.0.0.1:4445", "webdriver-1", () => undefined);
    await expect(session.evaluate("1 + 1")).resolves.toEqual({ value: 2 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:4445/session/webdriver-1/execute/sync",
      method: "POST",
      body: {
        args: []
      }
    });
    expect((requests[0].body as { script: string }).script).toContain("const __swiValue = (1 + 1);");
    expect((requests[0].body as { script: string }).script).toContain("JSON.stringify(__swiValue)");
  });

  test("preserves structured values returned by evaluate", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        value: {
          __swiKind: "json",
          json: JSON.stringify([{ id: "tap" }, { id: "name" }])
        }
      }), { status: 200 })
    ) as typeof fetch;

    const session = new WebDriverSession("http://127.0.0.1:4445", "webdriver-1", () => undefined);
    await expect(session.evaluate("[{ id: 'tap' }, { id: 'name' }]")).resolves.toEqual({
      value: [{ id: "tap" }, { id: "name" }]
    });
  });

  test("writes screenshot data returned by safaridriver", async () => {
    const pngBytes = Buffer.from("fake-png");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ value: pngBytes.toString("base64") }), { status: 200 })
    ) as typeof fetch;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "swi-webdriver-"));
    tempDirs.push(root);
    const target = path.join(root, "page.png");

    const session = new WebDriverSession("http://127.0.0.1:4445", "webdriver-1", () => undefined);
    await expect(writeWebDriverScreenshot(session, target)).resolves.toBe(true);
    await expect(fs.readFile(target)).resolves.toEqual(pngBytes);
  });

  test("maps Page.navigate to the WebDriver url endpoint", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      });
      return new Response(JSON.stringify({ value: null }), { status: 200 });
    }) as typeof fetch;

    const session = new WebDriverSession("http://127.0.0.1:4445", "webdriver-1", () => undefined);
    await expect(session.request("Page.navigate", { url: "https://example.com" })).resolves.toEqual({});
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4445/session/webdriver-1/url",
        method: "POST",
        body: {
          url: "https://example.com"
        }
      }
    ]);
  });
});
