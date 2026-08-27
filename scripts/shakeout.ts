import { randomUUID } from "node:crypto";
import { getConfig } from "../src/config.js";
import { checkEnvironment } from "../src/services/environment.js";
import { exportDebugBundle } from "../src/services/debug-bundle.js";
import { IwdpManager } from "../src/services/iwdp.js";
import { ProtocolSession } from "../src/services/protocol-session.js";
import { UiFallback } from "../src/services/ui-fallback.js";
import type { CrashState } from "../src/types.js";

async function main(): Promise<void> {
  const config = getConfig();
  const uiFallback = new UiFallback();
  const iwdp = new IwdpManager(config);
  try {
    const environment = await checkEnvironment();
    const bridge = await iwdp.ensureStarted();
    const devices = await iwdp.listDevices();

    const output: Record<string, unknown> = {
      environment,
      bridge,
      devices,
      pages: [],
      visibleCrashState: await uiFallback.getVisibleCrashState()
    };

    for (const device of devices) {
      const pages = await iwdp.listPages(device.deviceId);
      const pageResults = [];

      for (const page of pages) {
        const result: Record<string, unknown> = {
          page
        };

        if (page.webSocketDebuggerUrl) {
          const protocol = new ProtocolSession(page.webSocketDebuggerUrl, config.wsRequestTimeoutMs, () => undefined);
          try {
            await protocol.waitUntilOpen();
            const capabilities = await protocol.initializeCapabilities();
            result.capabilities = capabilities;
          } catch (error) {
            result.attachError = serializeError(error);
          } finally {
            protocol.dispose();
          }
        }

        pageResults.push(result);
      }

      output.pages = [...(output.pages as unknown[]), ...pageResults];
    }

    const crashedPageResult = (output.pages as Array<Record<string, unknown>>).find((entry) => {
      const page = entry.page as { title?: string };
      return page.title === "Web Page Crashed";
    });

    if (crashedPageResult) {
      const sessionId = randomUUID();
      const page = crashedPageResult.page as {
        deviceId: string;
        pageId: string;
        port: number;
        title: string;
        url: string;
        browserName: string;
        raw: Record<string, unknown>;
      };
      const crashState: CrashState = {
        crashed: true,
        reason: "Live shakeout found an inspectable Web Page Crashed target.",
        detectedAt: new Date().toISOString(),
        visibleInspectorCrash: Boolean((output.visibleCrashState as { visibleInspectorCrash?: boolean }).visibleInspectorCrash),
        visibleTitles: (output.visibleCrashState as { visibleTitles?: string[] }).visibleTitles ?? [],
        websocketClosed: false
      };

      output.crashBundle = await exportDebugBundle(
        config.bundleDir,
        {
          sessionId,
          device: devices[0],
          page,
          capabilities: {
            runtimeEval: false,
            console: false,
            network: false,
            domSnapshot: false,
            domActions: false,
            screenshot: false,
            uiRecovery: true
          },
          createdAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          websocketClosed: false,
          crash: crashState
        },
        [],
        [],
        crashState
      );
    }

    console.log(JSON.stringify(output, null, 2));
  } finally {
    await iwdp.stop();
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    };
  }

  return {
    message: String(error)
  };
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: serializeError(error) }, null, 2));
  process.exitCode = 1;
});
