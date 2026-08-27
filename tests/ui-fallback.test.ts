import { describe, expect, test } from "vitest";
import { detectVisibleCrash, parseWindowTitles } from "../src/services/ui-fallback.js";

describe("ui fallback parsing", () => {
  test("splits window titles", () => {
    expect(parseWindowTitles("Start Page, Web Inspector — Test iPhone — Safari — Web Page Crashed")).toEqual([
      "Start Page",
      "Web Inspector — Test iPhone — Safari — Web Page Crashed"
    ]);
  });

  test("detects visible crash state", () => {
    const result = detectVisibleCrash([
      "Start Page",
      "Web Inspector — Test iPhone — Safari — Web Page Crashed"
    ]);

    expect(result.visibleInspectorCrash).toBe(true);
    expect(result.visibleTitles).toHaveLength(2);
  });
});
