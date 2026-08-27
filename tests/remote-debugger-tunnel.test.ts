import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ensureRemoteDebuggerTunnelRegistry } from "../src/services/remote-debugger-tunnel.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("remote debugger tunnel registry", () => {
  test("probes the live registry and seeds the current strongbox container", async () => {
    const container = await fs.mkdtemp(path.join(os.tmpdir(), "tunnel-strongbox-"));
    tempDirs.push(container);
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: "OK" })
    } as Pick<Response, "ok" | "json">)) as unknown as typeof fetch;

    const result = await ensureRemoteDebuggerTunnelRegistry({
      fetchImpl,
      strongboxContainer: container
    });

    expect(result).toMatchObject({
      ready: true,
      port: 42314,
      source: "probe",
      seededStrongbox: true
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:42314/remotexpc/tunnels/metadata",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    await expect(fs.readFile(path.join(container, "tunnelRegistryPort"), "utf8")).resolves.toBe("42314");
  });
});
