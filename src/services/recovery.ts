import { setTimeout as delay } from "node:timers/promises";
import type { PageInfo, SessionCapabilities, SessionProtocol } from "../types.js";

export interface ProtocolRebindResult {
  page: PageInfo;
  protocol: SessionProtocol;
  capabilities: SessionCapabilities;
}

export interface ReloadAttempt {
  attempted: boolean;
}

export interface RecoveryDependencies {
  listPages(deviceId: string): Promise<PageInfo[]>;
  reconnectToPage(sessionId: string, page: PageInfo): Promise<ProtocolRebindResult>;
  attemptReload(): Promise<ReloadAttempt>;
  wait(ms: number): Promise<void>;
}

export interface RecoveryReconnectResult {
  recovered: boolean;
  method: "rediscovery-rebind" | "ui-reload-and-rebind" | "ui-reload-attempted";
  page?: PageInfo;
  protocol?: SessionProtocol;
  capabilities?: SessionCapabilities;
  reloadAttempt?: ReloadAttempt;
}

export async function recoverProtocolBinding(
  sessionId: string,
  page: PageInfo,
  deps: RecoveryDependencies
): Promise<RecoveryReconnectResult> {
  const rediscovered = await tryRediscoverPage(sessionId, page, deps);
  if (rediscovered) {
    return {
      recovered: true,
      method: "rediscovery-rebind",
      ...rediscovered
    };
  }

  const reloadAttempt = await deps.attemptReload();
  await deps.wait(1000);

  const retried = await tryRediscoverPage(sessionId, page, deps);
  if (retried) {
    return {
      recovered: true,
      method: "ui-reload-and-rebind",
      reloadAttempt,
      ...retried
    };
  }

  return {
    recovered: false,
    method: "ui-reload-attempted",
    reloadAttempt
  };
}

async function tryRediscoverPage(
  sessionId: string,
  page: PageInfo,
  deps: RecoveryDependencies
): Promise<ProtocolRebindResult | undefined> {
  const pages = await deps.listPages(page.deviceId);
  const candidate = pages.find((entry) => entry.pageId === page.pageId || entry.url === page.url);
  if (!candidate) {
    return undefined;
  }

  try {
    return await deps.reconnectToPage(sessionId, candidate);
  } catch {
    return undefined;
  }
}

export const defaultRecoveryWait = delay;
