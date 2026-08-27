import type { ToolErrorCode } from "./types.js";

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ToolErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}
