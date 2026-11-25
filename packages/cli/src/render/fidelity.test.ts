// What the browser draws that Figma needs spelled out, in a real browser: a box that scrolls clips and keeps
// the height it shows; native checkboxes and radio buttons are drawn, ticked in the accent colour. Skipped
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
  await page.setContent(`<body style="margin:0"><div id="storybook-root"><div style="width:400px">${body}</div></div></body>`);
  return page.evaluate(extractInPage);
}
const find = (n: IRNode, f: (x: IRNode) => boolean): IRNode | undefined =>
  f(n) ? n : (n.children ?? []).reduce<IRNode | undefined>((a, c) => a ?? find(c, f), undefined);

describe("drawn as the browser draws it", () => {
  it("a list capped by max-height that scrolls clips, at the height it shows", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<ul data-cdf="Fields" style="max-height:120px;overflow-y:auto;margin:0">${"<li style='height:40px'>x</li>".repeat(8)}</ul>`,
    );
    const list = find(root, (x) => x.name === "Fields")!;
    expect(list.clip).toBe(true);
    expect(list.height).toBe(120);
    expect(list.sizing.h).toBe("fixed");
  });

  it("a panel scrolled down shows its content moved up by that much, clipped", async (t) => {
    if (!browser) return t.skip();
    await page.setContent(
      `<body style="margin:0"><div id="storybook-root"><div style="width:400px"><div data-cdf="Panel" style="height:100px;overflow-y:auto;padding:8px">${"<p style='height:40px;margin:0'>row</p>".repeat(6)}</div></div></div></body>`,
    );
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-cdf="Panel"]')!.scrollTop = 60;
    });
    const root = await page.evaluate(extractInPage);
    const panel = find(root, (x) => x.name === "Panel")!;
    expect(panel.clip).toBe(true);
    expect(panel.height).toBe(116);
    const content = panel.children![0]!;
    expect(content.name).toBe("scrolled");
    expect(content.absolute).toEqual({ x: 0, y: -60 });
    expect(content.height).toBe(256); // its whole content: 6 rows and the padding
    expect(content.layout!.padding[0].value).toBe(8);
    expect(content.children!.length).toBe(6);
  });

  it("rows of a scrolling grid that are h-full keep their height, not squeezed to fit", async (t) => {
    if (!browser) return t.skip();
    const row = (i: number) => `<label data-cdf="Row${i}" style="height:100%;display:block"><p style="height:70px;margin:0">x</p></label>`;
    const root = await extract(
      `<div data-cdf="List" style="display:grid;gap:8px;max-height:200px;overflow-y:auto">${[1, 2, 3, 4].map(row).join("")}</div>`,
    );
    const r = find(root, (x) => x.name === "Row1")!;
    expect(r.sizing.h).toBe("fixed");
    expect(r.height).toBe(70);
    expect(find(root, (x) => x.name === "List")!.height).toBe(200);
  });

  it("the stretched cells of a scrolling grid keep their height (a dialog's list)", async (t) => {
    if (!browser) return t.skip();
    const row = (i: number) => `<li data-cdf="Item${i}" style="list-style:none"><p style="height:56px;margin:0">x</p></li>`;
    const root = await extract(
      `<ul data-cdf="Tools" style="display:grid;grid-template-columns:minmax(0,1fr);gap:6px;max-height:256px;overflow-y:auto;margin:0;padding:0">${[1, 2, 3, 4, 5].map(row).join("")}</ul>`,
    );
    const item = find(root, (x) => x.name === "Item1")!;
    expect(item.sizing.h).toBe("fixed");
    expect(item.height).toBe(56);
  });

  it("a grid filled column by column lists its items row by row, as Figma fills a grid", async (t) => {
    if (!browser) return t.skip();
    const chip = (n: string) => `<button data-cdf="${n}" style="height:30px">${n}</button>`;
    const root = await extract(
      `<div data-cdf="Chips" style="display:grid;grid-auto-flow:column;grid-template-rows:repeat(2,auto);gap:8px;width:max-content">${chip("A")}${chip("B")}${chip("C")}</div>`,
    );
    expect(find(root, (x) => x.name === "Chips")!.children!.map((c) => c.name)).toEqual(["A", "C", "B"]);
  });

  it("dialogs fixed to the window are stacked by z-index, not by where they are in the page", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div><div data-cdf="Picker" style="position:fixed;inset:20px;z-index:999;background:#fff">pages</div></div><section><div data-cdf="Website" style="position:fixed;inset:0;z-index:70;background:#000">site</div></section>`,
    );
    expect(root.children!.slice(-2).map((c) => c.name)).toEqual(["Website", "Picker"]);
  });

  it("a positioned layer is drawn over the content after it, by z-index; a negative one under it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Shell" style="position:relative"><button data-cdf="Show" style="position:absolute;right:0;top:10px">‹</button><span data-cdf="Back" style="position:absolute;inset:0;z-index:-1"></span><main data-cdf="Main" style="height:100px;background:#fff">x</main></div>`,
    );
    expect(find(root, (x) => x.name === "Shell")!.children!.map((c) => c.name)).toEqual(["Back", "Main", "Show"]);
  });

  it("list items show their bullet or number", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<ul style="list-style:disc;padding-left:20px"><li data-cdf="Sugar">1 cup sugar</li><li data-cdf="Fmt"><b>Formats:</b> .docx, .pdf</li></ul><ol style="padding-left:20px"><li>Heat oven</li><li data-cdf="Mix">Mix dry ingredients</li></ol><ol type="a" style="list-style-type:lower-alpha"><li>x</li><li data-cdf="B">y</li></ol>`,
    );
    expect(find(root, (x) => x.name === "Sugar")!.text!.characters).toBe("• 1 cup sugar");
    const fmt = find(root, (x) => x.name === "Fmt")!.text!;
    expect(fmt.characters).toBe("• Formats: .docx, .pdf");
    expect(fmt.runs).toEqual([{ start: 2, end: 10, fontWeight: 700 }]);
    expect(find(root, (x) => x.name === "Mix")!.text!.characters).toBe("2. Mix dry ingredients");
    expect(find(root, (x) => x.name === "B")!.text!.characters).toBe("b. y");
  });

  it("a row pushed to the end (justify-content: flex-end, which Chrome may report as flow-end) stays at the end", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Backdrop" style="display:flex;justify-content:flex-end;width:400px;height:100px"><aside style="width:150px">x</aside></div><div data-cdf="Col" style="display:flex;flex-direction:column;align-items:flex-end;width:400px"><span>y</span></div>`,
    );
    expect(find(root, (x) => x.name === "Backdrop")!.layout!.justify).toBe("MAX");
    expect(find(root, (x) => x.name === "Col")!.layout!.align).toBe("MAX");
  });

  it("a row of links keeps each at its width, and an auto margin takes the room that's left", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Bar" style="display:flex;flex-wrap:wrap;gap:12px;width:500px"><button data-cdf="All">Select all</button><button>Select none</button><label data-cdf="Open" style="margin-left:auto">Include open</label></div>`,
    );
    const bar = find(root, (x) => x.name === "Bar")!;
    expect(bar.layout!.wrap).toBeUndefined();
    expect(find(root, (x) => x.name === "All")!.sizing.w).toBe("hug");
    const gap = bar.children!.find((c) => c.name === "Open-margin-left")!;
    expect(gap.sizing.w).toBe("fill");
  });

  it("centred text in a block of the page's flow still spans the block", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<p data-cdf="Empty" style="text-align:center;margin:0">Nothing yet.</p>`);
    expect(find(root, (x) => x.name === "Empty")!.sizing.w).toBe("fill");
  });

  it("a one-column grid is a stack with the grid's row gap (Figma's grid would share its height between rows)", async (t) => {
    if (!browser) return t.skip();
    const row = (i: number) => `<label data-cdf="W${i}" style="height:100%;display:block"><p style="height:78px;margin:0">x</p></label>`;
    const root = await extract(
      `<div data-cdf="Flows" style="display:grid;grid-template-columns:minmax(0,1fr);gap:8px;max-height:272px;overflow-y:auto">${[1, 2, 3, 4].map(row).join("")}</div>`,
    );
    const list = find(root, (x) => x.name === "Flows")!;
    expect(list.layout!.direction).toBe("VERTICAL");
    expect(list.layout!.gap.value).toBe(8);
    expect(list.height).toBe(272);
    expect(find(root, (x) => x.name === "W1")!.height).toBe(78);
  });

  it("a grid row keeps its order when a thin bar in it starts lower than the texts beside it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Row" style="display:grid;grid-template-columns:40px 100px 1fr 48px;align-items:center;gap:8px;width:400px;height:40px"><span data-cdf="Icon" style="height:40px"></span><span data-cdf="Name">Web embed</span><span data-cdf="Bar" style="height:8px;background:#ccc"></span><span data-cdf="Pct">62%</span></div>`,
    );
    expect(find(root, (x) => x.name === "Row")!.children!.map((c) => c.name)).toEqual(["Icon", "Name", "Bar", "Pct"]);
  });

  it("a scrolling box whose content fits still clips, and hugs it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div data-cdf="Short" style="max-height:300px;overflow:auto"><p style="height:40px;margin:0">x</p></div>`);
    const box = find(root, (x) => x.name === "Short")!;
    expect(box.clip).toBe(true);
    expect(box.sizing.h).not.toBe("fixed");
  });

  it("native checkboxes and radio buttons: ticked in the accent colour, empty when not", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<input type="checkbox" data-cdf="On" checked style="accent-color:#2563eb"><input type="checkbox" data-cdf="Off"><input type="radio" data-cdf="Pick" checked>`,
    );
    const on = find(root, (x) => x.name === "On")!;
    expect(on.type).toBe("SVG");
    expect(on.svg).toContain('fill="#2563eb"');
    expect(on.svg).toContain("<path");
    const off = find(root, (x) => x.name === "Off")!;
    expect(off.svg).toContain('stroke="#767676"');
    expect(off.svg).not.toContain("<path");
    expect(find(root, (x) => x.name === "Pick")!.svg).toContain('fill="#0075ff"');
  });

  it("a disabled checkbox in Chrome's greys (an opacity on the SVG is lost in Figma)", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<input type="checkbox" data-cdf="Always" checked disabled>`);
    const svg = find(root, (x) => x.name === "Always")!.svg!;
    expect(svg).toContain('fill="#d1d1d1"');
    expect(svg).not.toContain("opacity");
  });

  it("an icon sized by CSS (width=1em) is exported at the size it's drawn, so its lines scale with it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<svg data-cdf="Bubble" width="1em" height="1em" viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.5" style="width:176px;height:176px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    );
    const svg = find(root, (x) => x.name === "Bubble")!.svg!;
    expect(svg).toMatch(/width="176"/);
    expect(svg).toMatch(/height="176"/);
    expect(svg).toContain('viewBox="0 0 24 24"');
  });

  it("text for screen readers only (sr-only) isn't drawn", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<button data-cdf="Pill"><span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">Agent model</span><span>Base model</span></button>`,
    );
    const texts: string[] = [];
    const all = (n: IRNode) => {
      if (n.text) texts.push(n.text.characters);
      for (const c of n.children ?? []) all(c);
    };
    all(root);
    expect(texts).toContain("Base model");
    expect(texts).not.toContain("Agent model");
  });

  it("text written in pieces ({pct}%) reads as the browser shows it, without spaces between them", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<span data-cdf="Pct"></span><p data-cdf="Row">Share: <b>x</b></p>`);
    // Two text nodes, as React writes {62}%.
    await page.evaluate(() => {
      const s = document.querySelector('[data-cdf="Pct"]')!;
      s.append(document.createTextNode("62"), document.createTextNode("%"));
      const p = document.querySelector('[data-cdf="Row"]')!;
      p.append(document.createTextNode("1"), document.createTextNode("0"));
    });
    const again = await page.evaluate(extractInPage);
    expect(root).toBeTruthy();
    expect(find(again, (x) => x.name === "Pct")!.text!.characters).toBe("62%");
    // A paragraph with a bold part: one text, the bold part a run.
    const row = find(again, (x) => x.name === "Row")!;
    expect(row.text!.characters).toBe("Share: x10");
    expect(row.text!.runs).toEqual([{ start: 7, end: 8, fontWeight: 700 }]);
  });

  it("centred one-line text fills its block, so it stays centred", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<p data-cdf="Empty" style="text-align:center;padding:32px 0">No questions in this period.</p>`);
    const label = find(root, (x) => x.name === "Empty")!.children![0]!;
    expect(label.text!.align).toBe("CENTER");
    expect(label.sizing.w).toBe("fill");
    expect(label.width).toBe(400);
  });

  it("a raised popup reaching over what follows is drawn on top of the page, not under it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div style="position:relative;height:40px"><div data-cdf="Popup" style="position:absolute;top:40px;left:0;z-index:30;width:200px;height:150px;background:#fff">x</div></div><div data-cdf="Cards" style="height:200px;background:#eee"></div><div style="position:relative;width:50px;height:50px"><span data-cdf="Badge" style="position:absolute;top:0;right:0;z-index:2;width:8px;height:8px;background:red"></span></div>`,
    );
    const last = root.children![root.children!.length - 1]!;
    expect(last.name).toBe("Popup");
    expect(last.absolute).toEqual({ x: 0, y: 40 });
    // A raised badge inside its box stays where it is.
    expect(root.children!.filter((c) => c.name === "Badge")).toHaveLength(0);
    expect(find(root, (x) => x.name === "Badge")).toBeTruthy();
  });

  it("a date field shows its date as the browser does, with the calendar button", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<input type="date" data-cdf="From" value="2025-12-03" style="width:160px">`);
    const field = find(root, (x) => x.name === "From")!;
    const value = field.children!.find((c) => c.name === "value")!.text!.characters;
    expect(value).not.toBe("2025-12-03");
    expect(value).toMatch(/2025/);
    expect(value).toMatch(/12/);
    expect(value).toMatch(/03|3/);
    expect(field.children!.find((c) => c.name === "calendar")?.type).toBe("SVG");
  });

  it("a paragraph with a bold part and a line break is one text with a styled run, as the browser flows it", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<p data-cdf="Note" style="margin:0;color:#52525b">Your account <b style="color:#18181b">marta@example.com</b> is on the list.<br>Thanks</p>`,
    );
    const note = find(root, (x) => x.name === "Note")!;
    expect(note.type).toBe("TEXT");
    expect(note.text!.characters).toBe("Your account marta@example.com is on the list.\nThanks");
    expect(note.text!.runs).toEqual([{ start: 13, end: 30, fontWeight: 700, color: "#18181b" }]);
  });

  it("an inline part with a box of its own (a pill) stays a layer of its own", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<p data-cdf="Status" style="margin:0">Status <span style="background:#eee;padding:2px 6px">New</span></p>`);
    expect(find(root, (x) => x.name === "Status")!.type).toBe("FRAME");
  });

  it("a font stack that starts with a generic name gives its first real font (code isn't drawn in Inter)", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<code data-cdf="Tool" style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace;font-style:italic">notion-search</code>`,
    );
    const tool = find(root, (x) => x.name === "Tool")!;
    expect(tool.text!.fontFamily).toBe("SFMono-Regular");
    expect(tool.text!.italic).toBe(true);
  });

  it("a box drawn with ::after (the selected tab's underline) is a layer where it's drawn; a hidden one isn't", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<style>.tab{position:relative;display:inline-block;padding:16px 4px}.tab::after{content:"";position:absolute;left:4px;right:4px;bottom:0;height:3px;background:#2563eb}.tab.off::after{transform:scaleX(0)}</style><nav style="display:flex;gap:8px"><a class="tab" data-cdf="On">Integrations</a><a class="tab off" data-cdf="Off">Exports</a></nav>`,
    );
    const on = find(root, (x) => x.name === "On")!;
    const line = on.children!.find((c) => c.name === "after")!;
    expect(line.fill?.value).toBe("#2563eb");
    expect(line.height).toBe(3);
    expect(line.width).toBe(on.width - 8);
    expect(line.absolute).toEqual({ x: 4, y: on.height - 3 });
    expect(line.layout?.direction).toBe("VERTICAL"); // every frame has one: the compiler needs it
    expect(find(root, (x) => x.name === "Off")!.children!.some((c) => c.name === "after")).toBe(false);
  });

  it("a wrapping row wraps in Figma only when its items do wrap in the browser", async (t) => {
    if (!browser) return t.skip();
    const item = `<button style="width:90px;height:30px">x</button>`;
    const root = await extract(
      `<div data-cdf="Fits" style="display:flex;flex-wrap:wrap;gap:8px;width:400px;align-items:center">${item}${item}<span style="height:10px">y</span></div><div data-cdf="Wraps" style="display:flex;flex-wrap:wrap;gap:8px;width:200px">${item}${item}${item}</div>`,
    );
    expect(find(root, (x) => x.name === "Fits")!.layout!.wrap).toBeUndefined();
    expect(find(root, (x) => x.name === "Wraps")!.layout!.wrap).toBe(true);
  });
});
