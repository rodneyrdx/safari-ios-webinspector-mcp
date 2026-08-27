import { ToolError } from "../errors.js";
import type { DomNodeSnapshot, SessionProtocol } from "../types.js";

interface DomEvalResult<T> {
  value?: T;
}

export function encodeDomRef(path: number[]): string {
  return `path:${path.join(".")}`;
}

export function decodeDomRef(ref: string): number[] {
  if (!ref.startsWith("path:")) {
    throw new ToolError("invalid_input", `Unsupported DOM ref format: ${ref}`);
  }
  const payload = ref.slice("path:".length);
  if (!payload) {
    return [];
  }
  return payload.split(".").map((item) => Number(item));
}

export async function getDomSnapshot(session: SessionProtocol): Promise<DomNodeSnapshot[]> {
  const expression = `(() => {
    const nodes = [];
    const walker = (node, path) => {
      if (!(node instanceof Element)) {
        return;
      }
      const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      nodes.push({
        ref: "path:" + path.join("."),
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.textContent || "").trim().slice(0, 200),
        id: node.id || undefined,
        className: typeof node.className === "string" ? node.className : undefined,
        role: node.getAttribute("role") || undefined,
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
      });
      Array.from(node.children).forEach((child, index) => walker(child, path.concat(index)));
    };
    walker(document.documentElement, []);
    return nodes;
  })()`;

  const result = await session.evaluate(expression) as DomEvalResult<DomNodeSnapshot[]>;
  return Array.isArray(result.value) ? result.value : [];
}

export async function clickElement(session: SessionProtocol, ref: string): Promise<{ clicked: boolean }> {
  const path = decodeDomRef(ref);
  const expression = domActionScript(path, "click");
  const result = await session.evaluate(expression) as DomEvalResult<{ clicked: boolean }>;
  return result.value ?? { clicked: false };
}

export async function fillElement(session: SessionProtocol, ref: string, value: string): Promise<{ filled: boolean }> {
  const path = decodeDomRef(ref);
  const expression = domActionScript(path, "fill", value);
  const result = await session.evaluate(expression) as DomEvalResult<{ filled: boolean }>;
  return result.value ?? { filled: false };
}

export async function pressKey(session: SessionProtocol, key: string): Promise<{ dispatched: boolean }> {
  const safeKey = JSON.stringify(key);
  const expression = `(() => {
    const target = document.activeElement || document.body;
    const event = new KeyboardEvent("keydown", { key: ${safeKey}, bubbles: true });
    target.dispatchEvent(event);
    return { dispatched: true };
  })()`;
  const result = await session.evaluate(expression) as DomEvalResult<{ dispatched: boolean }>;
  return result.value ?? { dispatched: false };
}

export async function waitForText(
  session: SessionProtocol,
  text: string,
  timeoutMs: number
): Promise<{ found: boolean }> {
  const safeText = JSON.stringify(text);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await session.evaluate(`(() => document.body && document.body.innerText.includes(${safeText}))()`) as DomEvalResult<boolean>;
    if (result.value) {
      return { found: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { found: false };
}

export async function navigate(session: SessionProtocol, url: string): Promise<{ navigated: boolean }> {
  try {
    await session.request("Page.navigate", { url });
    return { navigated: true };
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== "unsupported") {
      throw error;
    }
  }
  const safeUrl = JSON.stringify(url);
  const result = await session.evaluate(`(() => { location.href = ${safeUrl}; return true; })()`) as DomEvalResult<boolean>;
  return { navigated: Boolean(result.value) };
}

export async function goBack(session: SessionProtocol): Promise<{ navigatedBack: boolean }> {
  const result = await historyAction(session, "back", "Page.goBack");
  return { navigatedBack: result };
}

export async function goForward(session: SessionProtocol): Promise<{ navigatedForward: boolean }> {
  const result = await historyAction(session, "forward", "Page.goForward");
  return { navigatedForward: result };
}

export async function reload(session: SessionProtocol): Promise<{ reloaded: boolean }> {
  try {
    await session.request("Page.reload");
    return { reloaded: true };
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== "unsupported") {
      throw error;
    }
  }
  const result = await session.evaluate(`(() => { location.reload(); return true; })()`) as DomEvalResult<boolean>;
  return { reloaded: Boolean(result.value) };
}

async function historyAction(
  session: SessionProtocol,
  action: "back" | "forward",
  requestMethod: "Page.goBack" | "Page.goForward"
): Promise<boolean> {
  try {
    await session.request(requestMethod);
    return true;
  } catch (error) {
    if (!(error instanceof ToolError) || error.code !== "unsupported") {
      throw error;
    }
  }
  const result = await session.evaluate(
    `(() => { history.${action}(); return true; })()`
  ) as DomEvalResult<boolean>;
  return Boolean(result.value);
}

function domActionScript(path: number[], action: "click" | "fill", value = ""): string {
  const pathJson = JSON.stringify(path);
  const valueJson = JSON.stringify(value);
  return `(() => {
    const resolve = () => {
      let current = document.documentElement;
      for (const index of ${pathJson}) {
        if (!current || !current.children || !current.children[index]) {
          return null;
        }
        current = current.children[index];
      }
      return current;
    };
    const node = resolve();
    if (!node) {
      return { ${action === "click" ? "clicked" : "filled"}: false };
    }
    node.scrollIntoView({ block: "center", inline: "center" });
    if (${JSON.stringify(action)} === "click") {
      node.click();
      return { clicked: true };
    }
    if ("value" in node) {
      node.value = ${valueJson};
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true };
    }
    return { filled: false };
  })()`;
}
