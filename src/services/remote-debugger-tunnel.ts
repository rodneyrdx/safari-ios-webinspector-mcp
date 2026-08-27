import { BaseItem, strongbox } from "@appium/strongbox";

const TUNNEL_CONTAINER_NAME = "appium-xcuitest-driver";
const TUNNEL_REGISTRY_ITEM_NAME = "tunnelRegistryPort";
const DEFAULT_TUNNEL_REGISTRY_PORT = 42314;
const DEFAULT_TUNNEL_REGISTRY_TIMEOUT_MS = 1500;

type FetchLike = typeof fetch;

export type TunnelRegistryStatus = {
  ready: boolean;
  port?: number;
  source?: "strongbox" | "probe";
  seededStrongbox: boolean;
  strongboxPath?: string;
};

type TunnelRegistryOptions = {
  fetchImpl?: FetchLike;
  strongboxContainer?: string;
  timeoutMs?: number;
};

export async function ensureRemoteDebuggerTunnelRegistry(
  options: TunnelRegistryOptions = {}
): Promise<TunnelRegistryStatus> {
  const item = createTunnelRegistryItem(options.strongboxContainer);
  const storedPort = parsePort(await item.read());
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TUNNEL_REGISTRY_TIMEOUT_MS;

  if (storedPort && await isTunnelRegistryHealthy(storedPort, fetchImpl, timeoutMs)) {
    return {
      ready: true,
      port: storedPort,
      source: "strongbox",
      seededStrongbox: false,
      strongboxPath: item.id
    };
  }

  for (const candidatePort of candidatePorts(storedPort)) {
    if (!await isTunnelRegistryHealthy(candidatePort, fetchImpl, timeoutMs)) {
      continue;
    }
    const seededStrongbox = storedPort !== candidatePort;
    if (seededStrongbox) {
      await item.write(String(candidatePort));
    }
    return {
      ready: true,
      port: candidatePort,
      source: "probe",
      seededStrongbox,
      strongboxPath: item.id
    };
  }

  return {
    ready: false,
    seededStrongbox: false,
    strongboxPath: item.id
  };
}

function candidatePorts(storedPort?: number): number[] {
  const envPort = parsePort(process.env.SAFARI_IOS_TUNNEL_REGISTRY_PORT);
  return [...new Set([storedPort, envPort, DEFAULT_TUNNEL_REGISTRY_PORT].filter((value): value is number => Boolean(value)))];
}

function createTunnelRegistryItem(container?: string) {
  const box = container
    ? strongbox(TUNNEL_CONTAINER_NAME, { container })
    : strongbox(TUNNEL_CONTAINER_NAME);
  return new BaseItem(TUNNEL_REGISTRY_ITEM_NAME, box);
}

async function isTunnelRegistryHealthy(port: number, fetchImpl: FetchLike, timeoutMs: number): Promise<boolean> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`http://127.0.0.1:${port}/remotexpc/tunnels/metadata`, { signal });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { status?: string };
    return payload.status === "OK";
  } catch {
    return false;
  }
}

function parsePort(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}
