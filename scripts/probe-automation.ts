import fs from "node:fs/promises";
import path from "node:path";
import { getConfig } from "../src/config.js";
import { probeAutomationShim } from "../src/services/automation-shim.js";
import { ensureDir, timestampId } from "../src/utils/fs.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.udid) {
    throw new Error("Missing required --udid argument.");
  }

  const config = getConfig();
  const probeDir = path.join(config.cacheDir, "probes");
  await ensureDir(probeDir);

  const result = await probeAutomationShim(args.udid, {
    url: args.url,
    timeoutMs: args.timeoutMs
  });

  const probePath = path.join(probeDir, `${timestampId()}-automation-shim.json`);
  await fs.writeFile(probePath, JSON.stringify(result, null, 2));

  console.log(JSON.stringify({
    ok: true,
    probePath,
    result
  }, null, 2));
}

function parseArgs(argv: string[]): { udid?: string; url?: string; timeoutMs?: number } {
  const result: { udid?: string; url?: string; timeoutMs?: number } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === "--udid" || arg === "-u") && next) {
      result.udid = next;
      index += 1;
      continue;
    }
    if ((arg === "--url" || arg === "-U") && next) {
      result.url = next;
      index += 1;
      continue;
    }
    if ((arg === "--timeout-ms" || arg === "-t") && next) {
      result.timeoutMs = Number(next);
      index += 1;
    }
  }

  return result;
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
});
