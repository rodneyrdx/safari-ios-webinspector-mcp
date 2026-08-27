import fs from "node:fs/promises";
import path from "node:path";
import type { AttachedSession, ConsoleMessage, CrashState, DebugBundleResult, NetworkRequestRecord } from "../types.js";
import { ensureDir, timestampId } from "../utils/fs.js";

export async function exportDebugBundle(
  bundleRoot: string,
  session: AttachedSession,
  consoleMessages: ConsoleMessage[],
  networkRequests: NetworkRequestRecord[],
  crashState: CrashState,
  screenshotPath?: string
): Promise<DebugBundleResult> {
  const bundleDir = path.join(bundleRoot, `${timestampId()}-${session.sessionId}`);
  await ensureDir(bundleDir);

  const files: string[] = [];

  files.push(await writeJson(bundleDir, "session.json", session));
  files.push(await writeJson(bundleDir, "console.json", consoleMessages));
  files.push(await writeJson(bundleDir, "network.json", networkRequests));
  files.push(await writeJson(bundleDir, "crash.json", crashState));

  if (screenshotPath) {
    const screenshotTarget = path.join(bundleDir, path.basename(screenshotPath));
    await fs.copyFile(screenshotPath, screenshotTarget);
    files.push(screenshotTarget);
  }

  return { bundleDir, files };
}

async function writeJson(bundleDir: string, filename: string, value: unknown): Promise<string> {
  const target = path.join(bundleDir, filename);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}
