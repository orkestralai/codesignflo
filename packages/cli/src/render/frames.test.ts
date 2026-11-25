// A story's iframes (a chat widget in its own frame): served from Storybook's public folders and read into
// the page's layers. Skipped without Chromium.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRNode } from "@codesignflo/core";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { extractPage, serveStatic } from "./render.js";

describe("iframes", () => {
  it("a folder is served as its index.html (the widget's /embed/<token> page)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cdf-static-"));
    mkdirSync(join(dir, "embed", "token"), { recursive: true });
    writeFileSync(join(dir, "embed", "token", "index.html"), "<p>widget</p>");
    const server = createServer(serveStatic(dir));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await (await fetch(`${base}/embed/token`)).text()).toBe("<p>widget</p>");
      expect((await fetch(`${base}/embed/missing`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("what a same-site iframe shows is read into its layer, placed where it's drawn", async (t) => {
    const browser = await chromium.launch().catch(() => null);
    if (!browser) return t.skip();
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      await page.addInitScript(() => {
        (globalThis as unknown as { __name: unknown }).__name = (f: unknown) => f;
      });
      const inside = `<body style='margin:0'><div id='storybook-root'><div data-cdf='Widget' style='width:300px;height:200px;background:#2563eb'><p style='margin:0;color:#fff'>Hello!</p></div></div></body>`;
      await page.setContent(
        `<body style="margin:0"><div id="storybook-root"><div style="padding:40px"><iframe data-cdf="Frame" srcdoc="${inside}" style="border:0;width:300px;height:200px;display:block"></iframe></div></div></body>`,
      );
      const root = await extractPage(page);
      const find = (n: IRNode, f: (x: IRNode) => boolean): IRNode | undefined =>
        f(n) ? n : (n.children ?? []).reduce<IRNode | undefined>((a, c) => a ?? find(c, f), undefined);
      const frame = find(root, (x) => x.name === "Frame")!;
      const widget = find(frame, (x) => x.name === "Widget")!;
      expect(widget.fill?.value).toBe("#2563eb");
      expect(find(widget, (x) => x.text?.characters === "Hello!")).toBeTruthy();
      expect(widget.at).toEqual({ x: 40, y: 40 });
      expect(frame.clip).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
