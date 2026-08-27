import { describe, expect, test } from "vitest";
import {
  extractSocketPayload,
  parseBrowsingContexts,
  parsePageListing,
  selectSafariApplicationId
} from "../src/services/automation-shim.js";

describe("automation shim helpers", () => {
  test("selects the Mobile Safari application id", () => {
    expect(selectSafariApplicationId({
      "PID:10": {
        WIRApplicationBundleIdentifierKey: "com.apple.WebKit.WebContent"
      },
      "PID:20": {
        WIRApplicationBundleIdentifierKey: "com.apple.mobilesafari"
      }
    })).toBe("PID:20");
  });

  test("parses normal and automation page listings", () => {
    expect(parsePageListing({
      a: {
        WIRPageIdentifierKey: 1,
        WIRTitleKey: "Docs",
        WIRURLKey: "https://example.com/docs",
        WIRTypeKey: "WIRTypeWebPage",
        WIRConnectionIdentifierKey: "key"
      },
      b: {
        WIRPageIdentifierKey: 9,
        WIRTitleKey: "Automation",
        WIRURLKey: "",
        WIRTypeKey: "WIRTypeAutomation"
      }
    })).toEqual([
      {
        pageId: 1,
        title: "Docs",
        url: "https://example.com/docs",
        type: "WIRTypeWebPage",
        isKey: true,
        raw: expect.any(Object)
      },
      {
        pageId: 9,
        title: "Automation",
        url: "",
        type: "WIRTypeAutomation",
        isKey: false,
        raw: expect.any(Object)
      }
    ]);
  });

  test("parses Automation browsing contexts", () => {
    expect(parseBrowsingContexts([
      {
        handle: "page-1",
        url: "https://example.com/",
        active: true,
        presentation: "Window"
      }
    ])).toEqual([
      {
        handle: "page-1",
        url: "https://example.com/",
        active: true,
        presentation: "Window",
        raw: expect.any(Object)
      }
    ]);
  });

  test("extracts socket payloads from string and buffer plist messages", () => {
    expect(extractSocketPayload({
      __selector: "_rpc_applicationSentData:",
      __argument: {
        WIRMessageDataKey: JSON.stringify({ id: 1, result: { ok: true } })
      }
    })).toEqual({ id: 1, result: { ok: true } });

    expect(extractSocketPayload({
      __selector: "_rpc_applicationSentData:",
      __argument: {
        WIRSocketDataKey: Buffer.from(JSON.stringify({ method: "Automation.bidiMessageSent" }))
      }
    })).toEqual({ method: "Automation.bidiMessageSent" });
  });
});
