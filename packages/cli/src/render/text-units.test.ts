// Text read in a real browser: an emoji in styled text (it's two UTF-16 units: the runs used to shift after it
// and the read crashed), and each element's classes (how Tailwind components are told apart). Skipped
// without Chromium.
import type { IRNode } from "@codesignflo/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractInPage } from "./extract-in-page.js";

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch().catch(() => null);
  if (browser) page = await browser.newPage({ viewport: { width: 800, height: 600 } });
});
afterAll(async () => {
  await browser?.close();
});

async function extract(body: string): Promise<IRNode> {
  await page.setContent(`<body style="margin:0"><div id="storybook-root">${body}</div></body>`);
  return page.evaluate(extractInPage);
}
const texts = (n: IRNode): IRNode[] => (n.type === "TEXT" ? [n] : (n.children ?? []).flatMap(texts));

describe("text with an emoji in a styled part", () => {
  it("is read, and its styled parts stay where they are", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div class="my-1 flex w-full items-center gap-3"><span style="font-weight:600;font-size:12px"><span aria-hidden="true">👋 </span>Daniela <b>joined</b> the chat</span></div>`,
    );
    const [line] = texts(root);
    expect(line!.text!.characters).toBe("👋 Daniela joined the chat");
    const bold = line!.text!.runs?.find((r) => r.fontWeight && r.fontWeight >= 700);
    if (bold) expect(line!.text!.characters.slice(bold.start, bold.end)).toBe("joined");
  });
});

describe("classes", () => {
  it("each element carries its classes, sorted", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div class="px-3 flex items-center gap-2 rounded-lg"><p class="text-sm">Hi</p></div>`);
    expect(root.cls).toBe("flex gap-2 items-center px-3 rounded-lg");
  });
});
