import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { getConfig } from "../src/config.js";
import { IwdpManager } from "../src/services/iwdp.js";
import { ensureDir, timestampId } from "../src/utils/fs.js";
import type { PageInfo } from "../src/types.js";

interface FrameRecord {
  timestamp: string;
  direction: "in" | "out";
  payload: unknown;
}

interface TraceTarget {
  targetId: string;
  type: string;
  isPaused: boolean;
}

interface CommandOutcome {
  method: string;
  route: string;
  topLevel?: unknown;
  nested?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = getConfig();
  const traceDir = path.join(config.cacheDir, "traces");
  await ensureDir(traceDir);

  const iwdp = new IwdpManager(config);
  try {
    await iwdp.ensureStarted();
    const devices = await iwdp.listDevices();
    const device = devices.find((entry) => !args.deviceId || entry.deviceId === args.deviceId);
    if (!device) {
      throw new Error(`No device found${args.deviceId ? ` for ${args.deviceId}` : ""}.`);
    }

    const pages = await iwdp.listPages(device.deviceId);
    const page = selectPage(pages, args.pageId, args.urlContains);
    if (!page?.webSocketDebuggerUrl) {
      throw new Error("No matching page with websocket debugger URL was found.");
    }

    const trace = await runTrace(page.webSocketDebuggerUrl, args.timeoutMs);
    const filename = `${timestampId()}-${page.pageId}.json`;
    const tracePath = path.join(traceDir, filename);

    await fs.writeFile(tracePath, JSON.stringify({
      device,
      page,
      ...trace
    }, null, 2));

    console.log(JSON.stringify({
      ok: true,
      tracePath,
      page,
      targets: trace.targets,
      outcomes: trace.outcomes
    }, null, 2));
  } finally {
    await iwdp.stop();
  }
}

function parseArgs(argv: string[]) {
  const result: {
    deviceId?: string;
    pageId?: string;
    urlContains?: string;
    timeoutMs: number;
  } = {
    timeoutMs: 1000
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--device-id" && next) {
      result.deviceId = next;
      index += 1;
      continue;
    }
    if (arg === "--page-id" && next) {
      result.pageId = next;
      index += 1;
      continue;
    }
    if (arg === "--url-contains" && next) {
      result.urlContains = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      result.timeoutMs = Number(next);
      index += 1;
    }
  }

  return result;
}

function selectPage(pages: PageInfo[], pageId?: string, urlContains?: string): PageInfo | undefined {
  if (pageId) {
    return pages.find((page) => page.pageId === pageId);
  }
  if (urlContains) {
    return pages.find((page) => page.url.includes(urlContains));
  }
  return pages.find((page) => page.webSocketDebuggerUrl && page.title !== "Web Page Crashed")
    ?? pages.find((page) => page.webSocketDebuggerUrl);
}

async function runTrace(websocketUrl: string, timeoutMs: number) {
  const ws = new WebSocket(websocketUrl);
  const frames: FrameRecord[] = [];
  const targets = new Map<string, TraceTarget>();
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const nestedPending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let requestId = 0;
  let nestedId = 10_000;

  const waitForOpen = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out opening trace websocket.")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  ws.on("message", (data) => {
    const text = String(data);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      frames.push({ timestamp: new Date().toISOString(), direction: "in", payload: text });
      return;
    }

    frames.push({ timestamp: new Date().toISOString(), direction: "in", payload });

    const method = typeof payload.method === "string" ? payload.method : "";
    const params = typeof payload.params === "object" && payload.params !== null
      ? payload.params as Record<string, unknown>
      : {};

    if (typeof payload.id === "number") {
      const entry = pending.get(payload.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      pending.delete(payload.id);
      entry.resolve(payload);
      return;
    }

    if (method === "Target.targetCreated") {
      const targetInfo = typeof params.targetInfo === "object" && params.targetInfo !== null
        ? params.targetInfo as Record<string, unknown>
        : {};
      const targetId = typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
      const type = typeof targetInfo.type === "string" ? targetInfo.type : "unknown";
      if (targetId) {
        targets.set(targetId, {
          targetId,
          type,
          isPaused: Boolean(targetInfo.isPaused)
        });
      }
      return;
    }

    if (method === "Target.dispatchMessageFromTarget") {
      const message = typeof params.message === "string" ? params.message : "";
      if (!message) {
        return;
      }
      let nested: Record<string, unknown>;
      try {
        nested = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof nested.id !== "number") {
        return;
      }
      const entry = nestedPending.get(nested.id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      nestedPending.delete(nested.id);
      entry.resolve(nested);
    }
  });

  await waitForOpen;
  await sleep(250);

  const outcomes: CommandOutcome[] = [];
  outcomes.push(await sendDirect(ws, pending, ++requestId, timeoutMs, frames, "Target.setPauseOnStart", { pauseOnStart: true }, "direct"));

  const pageProxyId = parsePageProxyId(websocketUrl);
  const routeTargets = [...targets.values()].filter((target) => target.type === "page" || target.type === "frame");
  for (const target of routeTargets) {
    for (const includePageProxyId of [false, true]) {
      if (includePageProxyId && !pageProxyId) {
        continue;
      }
      const routeLabel = `${target.type}:${target.targetId}${includePageProxyId ? `:pageProxyId=${pageProxyId}` : ""}`;
      for (const method of ["Inspector.enable", "Page.enable", "Runtime.enable", "Runtime.evaluate"]) {
        const params = method === "Runtime.evaluate"
          ? { expression: "location.href", returnByValue: true, awaitPromise: true }
          : {};
        outcomes.push(await sendWrapped(
          ws,
          pending,
          nestedPending,
          ++requestId,
          ++nestedId,
          timeoutMs,
          frames,
          method,
          params,
          target.targetId,
          includePageProxyId ? pageProxyId : undefined,
          routeLabel
        ));
      }
    }
  }

  ws.close();
  await sleep(100);

  return {
    websocketUrl,
    targets: [...targets.values()],
    frames,
    outcomes
  };
}

async function sendDirect(
  ws: WebSocket,
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>,
  id: number,
  timeoutMs: number,
  frames: FrameRecord[],
  method: string,
  params: Record<string, unknown>,
  route: string
): Promise<CommandOutcome> {
  try {
    const response = await sendTopLevel(ws, pending, id, timeoutMs, frames, { id, method, params });
    await sleep(150);
    return { method, route, topLevel: response };
  } catch (error) {
    return { method, route, error: describeError(error) };
  }
}

async function sendWrapped(
  ws: WebSocket,
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>,
  nestedPending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>,
  id: number,
  nestedId: number,
  timeoutMs: number,
  frames: FrameRecord[],
  method: string,
  params: Record<string, unknown>,
  targetId: string,
  pageProxyId: string | undefined,
  route: string
): Promise<CommandOutcome> {
  const nestedResult = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      nestedPending.delete(nestedId);
      reject(new Error(`Timed out waiting for nested response to ${method}.`));
    }, timeoutMs);
    nestedPending.set(nestedId, { resolve, reject, timer });
  });

  const payload: Record<string, unknown> = {
    id,
    method: "Target.sendMessageToTarget",
    params: {
      targetId,
      message: JSON.stringify({ id: nestedId, method, params })
    }
  };
  if (pageProxyId) {
    (payload.params as Record<string, unknown>).pageProxyId = pageProxyId;
  }

  try {
    const topLevel = await sendTopLevel(ws, pending, id, timeoutMs, frames, payload);
    const nested = await nestedResult;
    await sleep(100);
    return { method, route, topLevel, nested };
  } catch (error) {
    const entry = nestedPending.get(nestedId);
    if (entry) {
      clearTimeout(entry.timer);
      nestedPending.delete(nestedId);
    }
    return { method, route, error: describeError(error) };
  }
}

async function sendTopLevel(
  ws: WebSocket,
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>,
  id: number,
  timeoutMs: number,
  frames: FrameRecord[],
  payload: Record<string, unknown>
): Promise<unknown> {
  frames.push({ timestamp: new Date().toISOString(), direction: "out", payload });

  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for top-level response to ${String(payload.method)}.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify(payload), (error) => {
      if (!error) {
        return;
      }
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
}

function parsePageProxyId(websocketUrl: string): string | undefined {
  const match = websocketUrl.match(/\/devtools\/page\/([^/?#]+)/);
  return match?.[1];
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: describeError(error) }, null, 2));
  process.exitCode = 1;
});
