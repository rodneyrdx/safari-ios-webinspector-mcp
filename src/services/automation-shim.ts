import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type AnyRecord = Record<string, any>;

export interface AutomationPageDescriptor {
  pageId: number;
  title: string;
  url: string;
  type?: string;
  isKey: boolean;
  raw: Record<string, unknown>;
}

export interface AutomationBrowsingContext {
  handle: string;
  url: string;
  active: boolean;
  presentation?: string;
  raw: Record<string, unknown>;
}

export interface AutomationProbeResult {
  udid: string;
  appId: string;
  normalPages: AutomationPageDescriptor[];
  automationPages: AutomationPageDescriptor[];
  contextsBeforeCreate: AutomationBrowsingContext[];
  createdContext?: AutomationBrowsingContext;
  contextsAfterCreate: AutomationBrowsingContext[];
  createdContextHandle?: string;
  createdContextPresentation?: string;
  createdContextTitle?: string;
  screenshotBytes?: number;
  supportsExistingTabAdoption: boolean;
  supportsManagedAutomationContext: boolean;
  limitation: string;
  observedEvents: Array<{
    method: string;
    params?: Record<string, unknown>;
  }>;
}

export interface AutomationProbeOptions {
  url?: string;
  timeoutMs?: number;
  appId?: string;
}

interface ShimMessage {
  __selector?: string;
  __argument?: AnyRecord;
}

interface WebInspectorServiceLike {
  listenMessage(): AsyncGenerator<unknown, void, unknown>;
  stopListeningAsync(): Promise<void>;
  close(): Promise<void>;
  getConnectedApplications(): Promise<void>;
  forwardGetListing(appId: string): Promise<void>;
  forwardAutomationSessionRequest(
    sessionId: string,
    appId: string,
    capabilities?: Record<string, unknown>
  ): Promise<void>;
  forwardSocketSetup(
    sessionId: string,
    appId: string,
    pageId: number,
    automaticallyPause?: boolean
  ): Promise<void>;
  forwardSocketData(
    sessionId: string,
    appId: string,
    pageId: number,
    data: unknown
  ): Promise<void>;
}

interface RemoteXpcLike {
  close(): Promise<void>;
}

interface ProbeConnection {
  webInspectorService: WebInspectorServiceLike;
  remoteXPC?: RemoteXpcLike;
}

export async function probeAutomationShim(
  udid: string,
  options: AutomationProbeOptions = {}
): Promise<AutomationProbeResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const targetUrl = options.url ?? "https://example.com";
  const { Services } = await import("appium-ios-remotexpc");
  const connection = await Services.startWebInspectorService(udid) as ProbeConnection;
  const collector = new ShimMessageCollector(connection.webInspectorService);
  const sessionId = randomUUID().toUpperCase();

  collector.start();

  try {
    const applicationsStart = collector.snapshotIndex();
    await connection.webInspectorService.getConnectedApplications();
    const applications = await collector.waitForSince(
      applicationsStart,
      extractConnectedApplications,
      timeoutMs,
      "connected application list"
    );

    const appId = options.appId ?? selectSafariApplicationId(applications);
    if (!appId) {
      throw new Error("No Mobile Safari application was exposed by the WebInspector shim.");
    }

    const firstListing = await fetchListing(connection.webInspectorService, collector, appId, timeoutMs);
    const normalPages = parsePageListing(firstListing).filter((page) => page.type !== "WIRTypeAutomation");

    const automationListingStart = collector.snapshotIndex();
    await connection.webInspectorService.forwardAutomationSessionRequest(sessionId, appId);
    const automationListing = await collector.waitForSince(
      automationListingStart,
      (message) => {
        const listing = extractListing(message, appId);
        if (!listing) {
          return undefined;
        }
        const pages = parsePageListing(listing);
        return pages.some((page) => page.type === "WIRTypeAutomation") ? listing : undefined;
      },
      timeoutMs,
      "automation page listing"
    );

    const automationPages = parsePageListing(automationListing).filter((page) => page.type === "WIRTypeAutomation");
    const automationPage = automationPages.at(-1);
    if (!automationPage) {
      throw new Error("Safari exposed no WIRTypeAutomation page after requesting an automation session.");
    }

    const socketStart = collector.snapshotIndex();
    await connection.webInspectorService.forwardSocketSetup(sessionId, appId, automationPage.pageId, false);
    await delay(150);

    const contextsBeforeResult = await sendAutomationSocketCommand(
      connection.webInspectorService,
      collector,
      socketStart,
      sessionId,
      appId,
      automationPage.pageId,
      "Automation.getBrowsingContexts",
      {},
      timeoutMs
    );
    const contextsBeforeCreate = parseBrowsingContexts(
      asRecord(contextsBeforeResult.result)?.contexts
    );

    const existingTabUrls = new Set(normalPages.map((page) => normalizeUrl(page.url)).filter(Boolean));
    const supportsExistingTabAdoption = contextsBeforeCreate.some((context) =>
      existingTabUrls.has(normalizeUrl(context.url))
    );

    const createResult = await sendAutomationSocketCommand(
      connection.webInspectorService,
      collector,
      collector.snapshotIndex(),
      sessionId,
      appId,
      automationPage.pageId,
      "Automation.createBrowsingContext",
      { presentationHint: "Tab" },
      timeoutMs
    );

    const createPayload = asRecord(createResult.result);
    const createdHandle = typeof createPayload?.handle === "string" ? createPayload.handle : undefined;
    const createdPresentation = typeof createPayload?.presentation === "string" ? createPayload.presentation : undefined;

    const contextsAfterCreateResult = await sendAutomationSocketCommand(
      connection.webInspectorService,
      collector,
      collector.snapshotIndex(),
      sessionId,
      appId,
      automationPage.pageId,
      "Automation.getBrowsingContexts",
      {},
      timeoutMs
    );
    const contextsAfterCreate = parseBrowsingContexts(
      asRecord(contextsAfterCreateResult.result)?.contexts
    );

    let createdContext = createdHandle
      ? contextsAfterCreate.find((context) => context.handle === createdHandle)
      : undefined;
    let createdContextTitle: string | undefined;
    let screenshotBytes: number | undefined;

    if (createdHandle) {
      await sendAutomationSocketCommand(
        connection.webInspectorService,
        collector,
        collector.snapshotIndex(),
        sessionId,
        appId,
        automationPage.pageId,
        "Automation.navigateBrowsingContext",
        {
          handle: createdHandle,
          url: targetUrl,
          pageLoadStrategy: "Normal",
          pageLoadTimeout: timeoutMs
        },
        timeoutMs
      );

      const contextResult = await sendAutomationSocketCommand(
        connection.webInspectorService,
        collector,
        collector.snapshotIndex(),
        sessionId,
        appId,
        automationPage.pageId,
        "Automation.getBrowsingContext",
        { handle: createdHandle },
        timeoutMs
      );
      const contextRecord = asRecord(contextResult.result);
      const createdContextRecord = asRecord(contextRecord?.context) ?? contextRecord;
      createdContext = createdContextRecord
        ? normalizeBrowsingContext(createdContextRecord)
        : createdContext;

      const titleResult = await sendAutomationSocketCommand(
        connection.webInspectorService,
        collector,
        collector.snapshotIndex(),
        sessionId,
        appId,
        automationPage.pageId,
        "Automation.evaluateJavaScriptFunction",
        {
          browsingContextHandle: createdHandle,
          function: "function () { return document.title; }",
          arguments: []
        },
        timeoutMs
      );
      createdContextTitle = parseJavascriptFunctionResult(asRecord(titleResult.result)?.result);

      const screenshotResult = await sendAutomationSocketCommand(
        connection.webInspectorService,
        collector,
        collector.snapshotIndex(),
        sessionId,
        appId,
        automationPage.pageId,
        "Automation.takeScreenshot",
        { handle: createdHandle },
        timeoutMs
      );
      const screenshotData = asRecord(screenshotResult.result)?.data;
      if (typeof screenshotData === "string" && screenshotData.length > 0) {
        screenshotBytes = Buffer.from(screenshotData, "base64").byteLength;
      }
    }

    return {
      udid,
      appId,
      normalPages,
      automationPages,
      contextsBeforeCreate,
      createdContext,
      contextsAfterCreate,
      createdContextHandle: createdHandle,
      createdContextPresentation: createdPresentation,
      createdContextTitle,
      screenshotBytes,
      supportsExistingTabAdoption,
      supportsManagedAutomationContext: Boolean(createdHandle),
      limitation: supportsExistingTabAdoption
        ? "Existing Safari tabs appeared as Automation browsing contexts."
        : "The Automation session created and drove its own isolated browsing context, but did not adopt any pre-existing Safari tab.",
      observedEvents: collectAutomationEvents(collector.listSince(socketStart))
    };
  } finally {
    await collector.stop().catch(() => undefined);
    await connection.webInspectorService.close().catch(() => undefined);
    await connection.remoteXPC?.close().catch(() => undefined);
  }
}

export function selectSafariApplicationId(applicationDictionary: Record<string, unknown>): string | undefined {
  return Object.entries(applicationDictionary).find(([, value]) => {
    const entry = asRecord(value);
    return entry?.WIRApplicationBundleIdentifierKey === "com.apple.mobilesafari";
  })?.[0];
}

export function parsePageListing(listing: unknown): AutomationPageDescriptor[] {
  const listingRecord = asRecord(listing);
  if (!listingRecord) {
    return [];
  }

  return Object.values(listingRecord)
    .map((value) => asRecord(value))
    .filter((value): value is AnyRecord => Boolean(value))
    .map((value) => ({
      pageId: Number(value.WIRPageIdentifierKey),
      title: typeof value.WIRTitleKey === "string" ? value.WIRTitleKey : "",
      url: typeof value.WIRURLKey === "string" ? value.WIRURLKey : "",
      type: typeof value.WIRTypeKey === "string" ? value.WIRTypeKey : undefined,
      isKey: value.WIRConnectionIdentifierKey !== undefined,
      raw: value
    }))
    .filter((page) => Number.isFinite(page.pageId));
}

export function parseBrowsingContexts(value: unknown): AutomationBrowsingContext[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is AnyRecord => Boolean(entry))
    .map(normalizeBrowsingContext)
    .filter((context) => Boolean(context.handle));
}

export function extractSocketPayload(message: unknown): Record<string, unknown> | undefined {
  const shimMessage = asShimMessage(message);
  if (shimMessage?.__selector !== "_rpc_applicationSentData:") {
    return undefined;
  }

  const data = shimMessage.__argument?.WIRMessageDataKey ?? shimMessage.__argument?.WIRSocketDataKey;
  if (typeof data === "string") {
    return parseJsonObject(data);
  }
  if (Buffer.isBuffer(data)) {
    return parseJsonObject(data.toString("utf8"));
  }
  return undefined;
}

function normalizeBrowsingContext(context: AnyRecord): AutomationBrowsingContext {
  return {
    handle: typeof context.handle === "string" ? context.handle : "",
    url: typeof context.url === "string" ? context.url : "",
    active: Boolean(context.active),
    presentation: typeof context.presentation === "string" ? context.presentation : undefined,
    raw: context
  };
}

function parseJavascriptFunctionResult(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

async function fetchListing(
  service: WebInspectorServiceLike,
  collector: ShimMessageCollector,
  appId: string,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const startIndex = collector.snapshotIndex();
  await service.forwardGetListing(appId);
  return collector.waitForSince(startIndex, (message) => extractListing(message, appId), timeoutMs, `page listing for ${appId}`);
}

async function sendAutomationSocketCommand(
  service: WebInspectorServiceLike,
  collector: ShimMessageCollector,
  startIndex: number,
  sessionId: string,
  appId: string,
  pageId: number,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const commandId = nextAutomationCommandId();
  await service.forwardSocketData(sessionId, appId, pageId, {
    id: commandId,
    method,
    params
  });

  return collector.waitForSince(
    startIndex,
    (message) => {
      const payload = extractSocketPayload(message);
      if (!payload || payload.id !== commandId) {
        return undefined;
      }
      return payload;
    },
    timeoutMs,
    `${method} socket response`
  );
}

function extractConnectedApplications(message: unknown): Record<string, unknown> | undefined {
  const shimMessage = asShimMessage(message);
  if (shimMessage?.__selector !== "_rpc_reportConnectedApplicationList:") {
    return undefined;
  }

  const applications = asRecord(shimMessage.__argument?.WIRApplicationDictionaryKey);
  return applications ?? undefined;
}

function extractListing(message: unknown, appId: string): Record<string, unknown> | undefined {
  const shimMessage = asShimMessage(message);
  if (shimMessage?.__selector !== "_rpc_applicationSentListing:") {
    return undefined;
  }

  if (shimMessage.__argument?.WIRApplicationIdentifierKey !== appId) {
    return undefined;
  }

  return asRecord(shimMessage.__argument?.WIRListingKey) ?? undefined;
}

function collectAutomationEvents(messages: unknown[]): Array<{ method: string; params?: Record<string, unknown> }> {
  const events: Array<{ method: string; params?: Record<string, unknown> }> = [];
  for (const message of messages) {
    const payload = extractSocketPayload(message);
    if (!payload || typeof payload.method !== "string" || payload.id !== undefined) {
      continue;
    }

    events.push({
      method: payload.method,
      params: asRecord(payload.params) ?? undefined
    });
  }
  return events;
}

function asShimMessage(message: unknown): ShimMessage | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return message as ShimMessage;
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" ? value as AnyRecord : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

let automationCommandId = 0;

function nextAutomationCommandId(): number {
  automationCommandId += 1;
  return automationCommandId;
}

class ShimMessageCollector {
  private readonly messages: unknown[] = [];
  private failure?: Error;
  private listenerTask?: Promise<void>;
  private stopped = false;

  constructor(private readonly service: WebInspectorServiceLike) {}

  start(): void {
    if (this.listenerTask) {
      return;
    }

    this.listenerTask = (async () => {
      try {
        for await (const message of this.service.listenMessage()) {
          if (this.stopped) {
            break;
          }
          this.messages.push(message);
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    })();
  }

  snapshotIndex(): number {
    return this.messages.length;
  }

  listSince(index: number): unknown[] {
    return this.messages.slice(index);
  }

  async waitForSince<T>(
    index: number,
    matcher: (message: unknown) => T | undefined,
    timeoutMs: number,
    description: string
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let cursor = index;

    while (Date.now() < deadline) {
      while (cursor < this.messages.length) {
        const message = this.messages[cursor];
        cursor += 1;
        const match = matcher(message);
        if (match !== undefined) {
          return match;
        }
      }

      if (this.failure) {
        throw this.failure;
      }

      await delay(25);
    }

    throw new Error(`Timed out waiting for ${description}.`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.service.stopListeningAsync().catch(() => undefined);
    await this.listenerTask?.catch(() => undefined);
  }
}
