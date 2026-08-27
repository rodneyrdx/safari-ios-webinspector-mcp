import type {
  AttachedSession,
  CrashState,
  DeviceInfo,
  NetworkRequestRecord,
  PageInfo,
  SessionCapabilities,
  SessionProtocol,
  SessionState
} from "../types.js";
import { ToolError } from "../errors.js";

interface StoredSession {
  attached: AttachedSession;
  protocol: SessionProtocol;
}

export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  add(
    sessionId: string,
    sessionKind: AttachedSession["sessionKind"],
    device: DeviceInfo,
    page: PageInfo,
    capabilities: SessionCapabilities,
    protocol: SessionProtocol
  ): AttachedSession {
    const attached: AttachedSession = {
      sessionId,
      sessionKind,
      device,
      page,
      capabilities,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      websocketClosed: false
    };

    this.sessions.set(sessionId, { attached, protocol });
    return attached;
  }

  get(sessionId: string): AttachedSession {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new ToolError("not_attached", `No session found for ${sessionId}.`);
    }
    return stored.attached;
  }

  getProtocol(sessionId: string): SessionProtocol {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new ToolError("not_attached", `No session found for ${sessionId}.`);
    }
    return stored.protocol;
  }

  touch(sessionId: string): void {
    const stored = this.sessions.get(sessionId);
    if (stored) {
      stored.attached.lastActivityAt = new Date().toISOString();
      stored.attached.websocketClosed = stored.protocol.isClosed();
    }
  }

  markCrashed(sessionId: string, protocolId: string, reason: string): void {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return;
    }
    if (stored.protocol.id !== protocolId) {
      return;
    }
    stored.attached.websocketClosed = true;
    stored.attached.crash = {
      crashed: true,
      reason,
      detectedAt: new Date().toISOString(),
      visibleInspectorCrash: false,
      visibleTitles: [],
      websocketClosed: true
    };
  }

  setCrashState(sessionId: string, crash: CrashState): void {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return;
    }
    stored.attached.crash = crash;
    stored.attached.websocketClosed = crash.websocketClosed;
  }

  rebind(sessionId: string, page: PageInfo, capabilities: SessionCapabilities, protocol: SessionProtocol): AttachedSession {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      throw new ToolError("not_attached", `No session found for ${sessionId}.`);
    }

    stored.protocol.dispose();
    stored.protocol = protocol;
    stored.attached.page = page;
    stored.attached.capabilities = capabilities;
    stored.attached.lastActivityAt = new Date().toISOString();
    stored.attached.websocketClosed = false;
    stored.attached.crash = undefined;
    return stored.attached;
  }

  remove(sessionId: string): void {
    const stored = this.sessions.get(sessionId);
    if (!stored) {
      return;
    }
    stored.protocol.dispose();
    this.sessions.delete(sessionId);
  }

  listStates(): SessionState[] {
    return [...this.sessions.values()].map(({ attached, protocol }) => ({
      sessionId: attached.sessionId,
      attached: !protocol.isClosed(),
      sessionKind: attached.sessionKind,
      deviceId: attached.device.deviceId,
      pageId: attached.page.pageId,
      pageUrl: attached.page.url,
      browserName: attached.page.browserName,
      iosVersion: attached.device.iosVersion,
      capabilities: attached.capabilities,
      consoleCount: protocol.getConsoleMessages().length,
      networkCount: protocol.getNetworkRequests().length,
      crashed: Boolean(attached.crash?.crashed),
      lastActivityAt: attached.lastActivityAt
    }));
  }

  getConsoleMessages(sessionId: string) {
    return this.getProtocol(sessionId).getConsoleMessages();
  }

  getNetworkRequests(sessionId: string): NetworkRequestRecord[] {
    return this.getProtocol(sessionId).getNetworkRequests();
  }
}
