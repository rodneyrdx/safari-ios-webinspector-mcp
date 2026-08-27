import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function execFileText(
  file: string,
  args: string[],
  timeoutMs = 5000
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: timeoutMs,
    encoding: "utf8"
  });

  return { stdout, stderr };
}

export async function commandPath(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileText("/bin/zsh", ["-lc", `command -v ${command}`], 3000);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
