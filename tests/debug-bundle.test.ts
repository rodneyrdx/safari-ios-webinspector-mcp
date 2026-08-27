import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { exportDebugBundle } from "../src/services/debug-bundle.js";
import type { AttachedSession, CrashState } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe("debug bundle export", () => {
  test("writes bundle files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "swi-bundle-"));
    tempDirs.push(root);

    const session: AttachedSession = {
      sessionId: "session-1",
      sessionKind: "attached_page",
      device: {
        deviceId: "ios-9222",
        displayName: "Test iPhone",
        port: 9222,
        browserFamily: "webkit",
        inspectable: true
      },
      page: {
        deviceId: "ios-9222",
        pageId: "page-1",
        port: 9222,
        title: "Game",
        url: "https://example.com",
        browserName: "Safari",
        backendHint: "iwdp_websocket",
        raw: {}
      },
      capabilities: {
        backend: "iwdp_websocket",
        runtimeEval: true,
        console: true,
        network: true,
        domSnapshot: true,
        domActions: true,
        screenshot: false,
        uiRecovery: true,
        transportMode: "direct",
        notes: []
      },
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      websocketClosed: false
    };

    const crashState: CrashState = {
      crashed: false,
      reason: "No crash detected.",
      visibleInspectorCrash: false,
      visibleTitles: [],
      websocketClosed: false
    };

    const result = await exportDebugBundle(root, session, [], [], crashState);
    expect(result.files).toHaveLength(4);
  });
});
