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

describe("a child aligned against its parent (align-self)", () => {
  const names = (n: IRNode): string[] => [n.name, ...(n.children ?? []).flatMap(names)];
  it("a label at the start of a centred column goes in a frame across the column that places it at the start", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div data-cdf="Stage" style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px">
      <span data-cdf="Label" style="align-self:flex-start;padding:4px 12px;background:#fff">Live preview</span>
      <div data-cdf="Phone" style="width:200px;height:120px;background:#000"></div></div>`);
    const stage = find(root, (x) => x.name === "Stage")!;
    expect(stage.layout?.align).toBe("CENTER");
    const wrap = find(stage, (x) => x.name === "Label-align")!;
    expect(wrap.layout).toMatchObject({ direction: "HORIZONTAL", justify: "MIN" });
    expect(wrap.sizing.w).toBe("fill");
    expect(wrap.children?.[0]?.name).toBe("Label");
    // The phone follows the column (centred): left as it is.
    expect(names(stage)).not.toContain("Phone-align");
  });
  it("a chat bubble at the end of a stretching column is placed at the end", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div data-cdf="Chat" style="display:flex;flex-direction:column;gap:8px;padding:12px">
      <p data-cdf="Bot" style="margin:0;max-width:200px;padding:8px">Hey there!</p>
      <p data-cdf="User" style="margin:0;max-width:200px;padding:8px;align-self:flex-end">Best zucchini bread recipe?</p></div>`);
    const chat = find(root, (x) => x.name === "Chat")!;
    const wrap = find(chat, (x) => x.name === "User-align")!;
    expect(wrap.layout).toMatchObject({ direction: "HORIZONTAL", justify: "MAX" });
    expect(names(chat)).not.toContain("Bot-align");
  });
  it("a row's child at the bottom while the row centres goes in a frame down the row", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div data-cdf="Row" style="display:flex;align-items:center;height:80px;gap:8px">
      <span data-cdf="Icon" style="width:20px;height:20px;background:#000"></span>
      <span data-cdf="Tag" style="align-self:flex-end;height:16px">new</span></div>`);
    const wrap = find(root, (x) => x.name === "Tag-align")!;
    expect(wrap.layout).toMatchObject({ direction: "VERTICAL", justify: "MAX" });
    expect(wrap.sizing.h).toBe("fill");
  });
});

describe("how things look beyond fill and border", () => {
  it("a round avatar picture keeps its radius, border, shadow and opacity", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<img data-cdf="Avatar" width="40" height="40" style="border-radius:50%;border:2px solid #ff0000;box-shadow:0 1px 2px #0003;opacity:.5" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==">`,
    );
    const img = find(root, (x) => x.name === "Avatar")!;
    expect(img.type).toBe("IMAGE");
    expect(img.radius?.value).toBe(22);
    expect(img.stroke).toMatchObject({ width: 2 });
    expect(img.shadow).toBeTruthy();
    expect(img.opacity).toBe(0.5);
  });
  it("corners rounded differently are kept per corner", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<div data-cdf="Tab" style="height:30px;background:#eee;border-radius:8px 8px 0 0"></div>`);
    expect(find(root, (x) => x.name === "Tab")!.radii).toEqual([8, 8, 0, 0]);
  });
  it("filters, backdrop blur, blending and an outline are read", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Glass" style="height:30px;background:#fff8;backdrop-filter:blur(8px);filter:blur(2px);mix-blend-mode:multiply;outline:2px solid #00ff00"></div>`,
    );
    const g = find(root, (x) => x.name === "Glass")!;
    expect(g.backdrop).toContain("blur");
    expect(g.filter).toContain("blur");
    expect(g.blend).toBe("multiply");
    expect(g.outline).toEqual({ color: "#00ff00", width: 2 });
  });
  it("text keeps its shadow, and underline or strikethrough from an inline parent", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<h1 data-cdf="Hero" style="text-shadow:0 2px 4px #0008;margin:0">Big</h1><a href="#" style="text-decoration:underline"><span data-cdf="Link">Open</span></a><p data-cdf="Old" style="text-decoration:line-through;margin:0">$20</p>`,
    );
    expect(find(root, (x) => x.name === "Hero")!.shadow).toContain("4px");
    expect(find(root, (x) => x.name === "Old")!.text?.decoration).toBe("STRIKETHROUGH");
    const link = find(root, (x) => x.type === "TEXT" && x.text?.characters === "Open")!;
    expect(link.text?.decoration).toBe("UNDERLINE");
  });
  it("an element hidden but in the flow keeps its room, drawn empty", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div style="display:flex;flex-direction:column"><div data-cdf="Ghost" style="visibility:hidden;height:24px;background:#f00">Saved</div><div data-cdf="Faded" style="opacity:0;height:10px"></div><p style="margin:0">After</p></div>`,
    );
    const ghost = find(root, (x) => x.name === "Ghost")!;
    expect(ghost).toMatchObject({ type: "FRAME", height: 24 });
    expect(ghost.fill).toBeUndefined();
    expect(ghost.children ?? []).toEqual([]);
    expect(find(root, (x) => x.name === "Faded")?.height).toBe(10);
  });
  it("a native select shows its chevron", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<select data-cdf="Plan" style="width:160px"><option>Monthly</option></select>`);
    const sel = find(root, (x) => x.name === "Plan")!;
    expect(sel.children?.map((c) => c.name)).toEqual(["value", "chevron"]);
  });
});

describe("drawings styled by CSS", () => {
  it("fill and stroke from classes become attributes; shapes CSS hides are left out", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<style>.ico path{fill:#ff0000;stroke:#0000ff;stroke-width:3px}.ico .off{display:none}</style>
      <svg data-cdf="Icon" class="ico" width="20" height="20" viewBox="0 0 20 20"><path d="M0 0h10v10z"/><circle class="off" cx="5" cy="5" r="2"/></svg>`);
    const svg = find(root, (x) => x.name === "Icon")!.svg!;
    expect(svg).toMatch(/<path[^>]*fill="rgb\(255, 0, 0\)"/);
    expect(svg).toMatch(/stroke-width="3"/);
    expect(svg).not.toContain("<circle");
  });
  it("a sprite icon (<use href>) gets the shapes it points at, in its colour", async (t) => {
    if (!browser) return t.skip();
    const root =
      await extract(`<svg style="display:none"><symbol id="star" viewBox="0 0 10 10"><path fill="currentColor" d="M0 0h10v10z"/></symbol></svg>
      <svg data-cdf="Star" width="20" height="20" style="color:#00ff00"><use href="#star"/></svg>`);
    const svg = find(root, (x) => x.name === "Star")!.svg!;
    expect(svg).not.toContain("<use");
    expect(svg).toContain('d="M0 0h10v10z"');
    expect(svg).toMatch(/fill="#00ff00"/);
    expect(svg).toContain("scale(2)");
  });
});

describe("what CSS adds with ::before and ::after", () => {
  it("a required label's * is part of its text; icon-font glyphs are left out", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<style>.req::after{content:" *";color:red}.ico::before{content:"\\e900"}</style>
      <label data-cdf="Name" class="req">Name</label><span data-cdf="Go" class="ico">Go</span>`);
    expect(find(root, (x) => x.name === "Name")!.text?.characters).toBe("Name *");
    expect(find(root, (x) => x.name === "Go")!.text?.characters).toBe("Go");
  });
  it("a badge drawn with ::after is a box with its text, placed with its translate", async (t) => {
    if (!browser) return t.skip();
    const root =
      await extract(`<style>.tab{position:relative;display:flex;padding:8px}.tab::after{content:"New";position:absolute;top:0;right:0;transform:translate(4px,-4px);background:#ff0000;padding:0 4px;font:10px/14px sans-serif}</style>
      <div data-cdf="Tab" class="tab"><span>Inbox</span><span>3</span></div>`);
    const tab = find(root, (x) => x.name === "Tab")!;
    const badge = tab.children!.find((c) => c.name === "after")!;
    expect(badge.type).toBe("FRAME");
    expect(badge.fill?.value).toBe("#ff0000");
    expect(badge.children?.[0]?.text?.characters).toBe("New");
    expect(badge.absolute!.y).toBe(-4);
  });
});

describe("the font the text is drawn in", () => {
  it("a web font that didn't load is passed over for the next in the stack", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<style>@font-face{font-family:Broken;src:url(data:font/woff2;base64,AAAA)}</style>
      <p data-cdf="Body" style="font-family:Broken, Georgia, serif;margin:0">Hello</p>`);
    await page.evaluate(() => document.fonts.ready);
    const family = find(root, (x) => x.name === "Body")!.text!.fontFamily;
    const georgia = await page.evaluate(() => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      ctx.font = '72px "Georgia", monospace';
      const a = ctx.measureText("mmmlliWW").width;
      ctx.font = "72px monospace";
      return a !== ctx.measureText("mmmlliWW").width;
    });
    expect(family).toBe(georgia ? "Georgia" : "Broken");
  });
});

describe("links and limits", () => {
  it("a link's text keeps where it goes; a part linking elsewhere in a paragraph is a run; relative links are left out", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(`<a data-cdf="Docs" href="https://example.com/docs">Read the docs</a>
      <p data-cdf="Terms" style="margin:0">See our <a href="https://example.com/terms">terms</a> or <a href="/help">help</a>.</p>`);
    expect(find(root, (x) => x.name === "Docs")!.text?.link).toBe("https://example.com/docs");
    const terms = find(root, (x) => x.name === "Terms")!.text!;
    expect(terms.link).toBeUndefined();
    const run = terms.runs?.find((r) => r.link);
    expect(terms.characters.slice(run!.start, run!.end)).toBe("terms");
    expect(terms.runs?.some((r) => r.link?.includes("/help"))).toBe(false);
  });
  it("min and max widths in pixels are kept", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div style="display:flex"><div data-cdf="Card" style="flex:1;max-width:300px;min-width:120px;min-height:40px;background:#eee"></div></div>`,
    );
    expect(find(root, (x) => x.name === "Card")!.limits).toEqual({ minW: 120, maxW: 300, minH: 40 });
  });
});

describe("align-self wrappers in rows that wrap", () => {
  it("cards on a second line of a wrapping row aren't taken for children placed at the end", async (t) => {
    if (!browser) return t.skip();
    const card = (i: number) => `<div data-cdf="Card-${i}" style="width:180px;height:100px;background:#eee"></div>`;
    const root = await extract(
      `<div data-cdf="Grid" style="display:flex;flex-wrap:wrap;gap:8px;width:400px">${[0, 1, 2, 3].map(card).join("")}</div>`,
    );
    const grid = find(root, (x) => x.name === "Grid")!;
    expect(grid.children?.map((c) => c.name)).toEqual(["Card-0", "Card-1", "Card-2", "Card-3"]);
  });
});

describe("a text in a box drawn only by a gradient or a shadow", () => {
  it("an avatar's gradient circle with its initials keeps the circle", async (t) => {
    if (!browser) return t.skip();
    const root = await extract(
      `<div data-cdf="Avatar" style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9999px;background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;box-shadow:0 1px 2px #0004">SJ</div>`,
    );
    const avatar = find(root, (x) => x.name === "Avatar")!;
    expect(avatar.type).toBe("FRAME");
    expect(avatar.gradient).toBeTruthy();
    expect(avatar.radius?.value).toBeGreaterThan(17);
    expect(avatar.children?.[0]?.text?.characters).toBe("SJ");
  });
});
