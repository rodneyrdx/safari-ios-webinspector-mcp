import { describe, expect, test } from "vitest";
import { ToolError } from "../src/errors.js";
import {
  decodeDomRef,
  encodeDomRef,
  goBack,
  goForward
} from "../src/services/dom-tools.js";

class MockProtocolSession {
  expressions: string[] = [];

  async request(): Promise<never> {
    throw new ToolError("unsupported", "mock request unsupported");
  }

  async evaluate(expression: string): Promise<{ value: boolean }> {
    this.expressions.push(expression);
    return { value: true };
  }
}

describe("dom refs", () => {
  test("round trips dom refs", () => {
    const ref = encodeDomRef([0, 3, 2]);
    expect(ref).toBe("path:0.3.2");
    expect(decodeDomRef(ref)).toEqual([0, 3, 2]);
  });

  test("dispatches browser history navigation", async () => {
    const session = new MockProtocolSession();

    await expect(goBack(session as never)).resolves.toEqual({ navigatedBack: true });
    await expect(goForward(session as never)).resolves.toEqual({ navigatedForward: true });
    expect(session.expressions).toEqual([
      "(() => { history.back(); return true; })()",
      "(() => { history.forward(); return true; })()"
    ]);
  });
});
