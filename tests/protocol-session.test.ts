import { afterEach, describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { ProtocolSession } from "../src/services/protocol-session.js";

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

describe("protocol session", () => {
  test("switches to brokered mode when Appium-style initialization succeeds without pageProxyId", async () => {
    const { url } = await startServer((ws) => {
      ws.send(JSON.stringify(targetCreated("page-30", "page")));
      let inspectorEnabled = false;
      let pageEnabled = false;
      let runtimeEnabled = false;

      ws.on("message", (payload) => {
        const message = JSON.parse(String(payload)) as Record<string, unknown>;
        if (message.method === "Runtime.enable" || message.method === "Console.enable" || message.method === "Network.enable" || message.method === "Page.enable") {
          ws.send(JSON.stringify(domainNotFound(message.id as number, String(message.method))));
          return;
        }
        if (message.method === "Target.setPauseOnStart") {
          ws.send(JSON.stringify({ id: message.id, result: {} }));
          return;
        }
        if (message.method === "Target.sendMessageToTarget") {
          const params = message.params as Record<string, unknown>;
          const nested = JSON.parse(String(params.message)) as Record<string, unknown>;
          ws.send(JSON.stringify({ id: message.id, result: {} }));

          if (params.pageProxyId) {
            return;
          }

          if (nested.method === "Inspector.enable") {
            inspectorEnabled = true;
            ws.send(JSON.stringify(dispatchFromTarget({ id: nested.id as number, result: {} })));
            return;
          }
          if (nested.method === "Page.enable" && inspectorEnabled) {
            pageEnabled = true;
            ws.send(JSON.stringify(dispatchFromTarget({ id: nested.id as number, result: {} })));
            return;
          }
          if (nested.method === "Runtime.enable" && pageEnabled) {
            runtimeEnabled = true;
            ws.send(JSON.stringify(dispatchFromTarget({ id: nested.id as number, result: {} })));
            return;
          }
          if (nested.method === "Network.enable" || nested.method === "Heap.enable" || nested.method === "Debugger.enable" || nested.method === "Console.enable" || nested.method === "Inspector.initialized") {
            ws.send(JSON.stringify(dispatchFromTarget({ id: nested.id as number, result: {} })));
            return;
          }
          if (nested.method === "Runtime.evaluate") {
            if (!runtimeEnabled) {
              return;
            }
            ws.send(JSON.stringify(dispatchFromTarget({
              id: nested.id as number,
              result: {
                result: {
                  type: "string",
                  value: "https://example.com"
                }
              }
            })));
          }
        }
      });
    });

    const session = new ProtocolSession(url, 500, () => undefined);
    await session.waitUntilOpen();

    const capabilities = await session.initializeCapabilities();
    expect(capabilities.transportMode).toBe("brokered");
    expect(capabilities.runtimeEval).toBe(true);
    expect(capabilities.console).toBe(true);
    expect(capabilities.network).toBe(true);
    expect(capabilities.screenshot).toBe(true);

    const value = await session.evaluate("location.href");
    expect(value).toEqual({
      type: "string",
      value: "https://example.com"
    });

    session.dispose();
  });

  test("downgrades to broker_only mode when wrapped responses never arrive", async () => {
    const { url } = await startServer((ws) => {
      ws.send(JSON.stringify(targetCreated("page-30", "page")));
      ws.on("message", (payload) => {
        const message = JSON.parse(String(payload)) as Record<string, unknown>;
        if (message.method === "Runtime.enable" || message.method === "Console.enable" || message.method === "Network.enable" || message.method === "Page.enable") {
          ws.send(JSON.stringify(domainNotFound(message.id as number, String(message.method))));
          return;
        }
        if (message.method === "Target.setPauseOnStart") {
          ws.send(JSON.stringify({ id: message.id, result: {} }));
          return;
        }
        if (message.method === "Target.sendMessageToTarget") {
          ws.send(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    });

    const session = new ProtocolSession(url, 150, () => undefined);
    await session.waitUntilOpen();

    const capabilities = await session.initializeCapabilities();
    expect(capabilities.transportMode).toBe("broker_only");
    expect(capabilities.runtimeEval).toBe(false);
    expect(capabilities.notes.some((note) => note.includes("Target broker"))).toBe(true);
    await expect(session.evaluate("location.href")).rejects.toThrow("Target broker");

    session.dispose();
  });
});

async function startServer(
  onConnection: (ws: import("ws").WebSocket) => void
): Promise<{ url: string }> {
  const server = new WebSocketServer({ port: 0 });
  servers.push(server);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  server.on("connection", onConnection);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  return {
    url: `ws://127.0.0.1:${address.port}/devtools/page/1`
  };
}

function targetCreated(targetId: string, type: string) {
  return {
    method: "Target.targetCreated",
    params: {
      targetInfo: {
        targetId,
        type
      }
    }
  };
}

function domainNotFound(id: number, method: string) {
  const domain = method.split(".")[0];
  return {
    id,
    error: {
      code: -32601,
      message: `'${domain}' domain was not found`
    }
  };
}

function dispatchFromTarget(message: Record<string, unknown>) {
  return {
    method: "Target.dispatchMessageFromTarget",
    params: {
      targetId: "page-30",
      message: JSON.stringify(message)
    }
  };
}
