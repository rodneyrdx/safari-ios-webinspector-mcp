import { execFileText } from "../utils/exec.js";
import { ToolError } from "../errors.js";

export interface VisibleCrashState {
  visibleInspectorCrash: boolean;
  visibleTitles: string[];
}

export function parseWindowTitles(input: string): string[] {
  return input
    .split(",")
    .map((title) => title.trim())
    .filter(Boolean);
}

export function detectVisibleCrash(titles: string[]): VisibleCrashState {
  return {
    visibleInspectorCrash: titles.some((title) => title.includes("Web Page Crashed")),
    visibleTitles: titles
  };
}

export class UiFallback {
  async getVisibleCrashState(): Promise<VisibleCrashState> {
    const titles = await this.listSafariWindowTitles();
    return detectVisibleCrash(titles);
  }

  async focusSafari(): Promise<void> {
    await this.runAppleScript(`tell application "Safari" to activate`);
  }

  async attemptReloadViaKeyboard(): Promise<{ attempted: boolean }> {
    await this.focusSafari();
    await this.runAppleScript(`
      tell application "System Events"
        keystroke "r" using {command down}
      end tell
    `);
    return { attempted: true };
  }

  async takeHostScreenshot(outputPath: string): Promise<string> {
    await execFileText("/usr/sbin/screencapture", ["-x", outputPath], 5000);
    return outputPath;
  }

  private async listSafariWindowTitles(): Promise<string[]> {
    try {
      const output = await this.runAppleScript(`
        tell application "System Events"
          tell process "Safari"
            get name of windows
          end tell
        end tell
      `);
      return parseWindowTitles(output);
    } catch {
      return [];
    }
  }

  private async runAppleScript(script: string): Promise<string> {
    try {
      const { stdout } = await execFileText("/usr/bin/osascript", ["-e", script], 5000);
      return stdout.trim();
    } catch (error) {
      throw new ToolError("unsupported", "macOS UI automation failed. Check Accessibility permissions.", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
