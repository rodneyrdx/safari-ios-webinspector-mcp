import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function joinFile(dir: string, filename: string): string {
  return path.join(dir, filename);
}
