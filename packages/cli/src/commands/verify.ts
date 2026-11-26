// codesignflo verify [component…] [--screens] [--widths=1280,768,375] [--strict] — does Live look like the code? Each variant story
// is screenshotted in the browser and compared with Figma's export of its Live variant (pages too with
// --screens). Writes browser | Figma | difference images and report.json to .codesignflo/verify/; the
// codesignflo-verify skill reads them and explains what differs.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { variantName } from "@codesignflo/core";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { dir, requireConfig } from "../project.js";
import { withStorybook } from "../render/render.js";
import { withPlugin } from "./connect.js";

type RegistryFile = {
  components: Record<string, { stories: Record<string, Record<string, string>> }>;
  screens: Record<string, { story: string }>;
};
export type VerifyRow = {
  component: string;
  variant: string;
  story: string;
  browser: { width: number; height: number };
  figma: { width: number; height: number } | null;
  /** Share of pixels outside text that differ visibly (0–1), over the larger of the two sizes. */
  mismatch: number | null;
  /** Structural similarity outside text (0–1, 1 the same): blind to anti-aliasing, not to moved or missing parts. */
  ssim?: number | null;
  /** The width it was compared at, when verify checked more than one (--widths). */
  width?: number;
  /** The story's play function failed: the browser shows Storybook's error, not the story. */
  storyError?: string;
  /** Share of pixels inside text boxes that differ (font rasterisation; informative only). */
  textMismatch?: number | null;
  /** The regions that differ most (outside text), worst first, each with the element the browser draws there. */
  hotspots?: Hotspot[];
  flagged: boolean;
  image?: string;
  /** Against the previous verify: worse or better (nothing when about the same, or new). */
  trend?: "worse" | "better";
};

/**
 * Thresholds: sizes within 2 px, under 3% of pixels different outside text. Inside text boxes the browser
 * and Figma rasterise the same font differently (glyph widths differ by fractions of a pixel), so text is
 * measured and reported separately and does not flag a variant on its own.
 */
const SIZE_PX = 2;
const MISMATCH = 0.03;
/**
 * Under MISMATCH, a variant is still flagged when over MISMATCH_LOW of its pixels differ and its structure does
 * too (SSIM under SSIM_MIN): edges that moved or parts that are missing, which anti-aliasing noise isn't.
 */
const MISMATCH_LOW = 0.01;
const SSIM_MIN = 0.95;
/**
 * A region whose pixels (outside text) differ this much flags the variant even when the whole is under
 * MISMATCH: a missing button is a few percent of a page, but nearly all of its own region.
 */
const HOTSPOT = 0.3;
/** Regions are made of CELL × CELL squares; a square counts when this share of its pixels differs. */
const CELL = 32;
const HOT_CELL = 0.2;

type Box = { x: number; y: number; width: number; height: number };
/** A region that differs: where (in the browser's picture), the share of its pixels that differ, what's there. */
export type Hotspot = Box & { share: number; at?: string };

/**
 * The regions where the two pictures differ most, outside text: CELL-sized squares where at least HOT_CELL of
 * the pixels differ, joined with their neighbours, the largest (in differing pixels) first, at most `max`.
 */
export function hotspots(red: Uint8Array, inText: Uint8Array, w: number, h: number, max = 5): Hotspot[] {
  const cols = Math.ceil(w / CELL);
  const rows = Math.ceil(h / CELL);
  const hot = new Uint8Array(cols * rows);
  const redIn = new Float64Array(cols * rows);
  const area = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (inText[i]) continue;
      const c = Math.floor(y / CELL) * cols + Math.floor(x / CELL);
      area[c]!++;
      if (red[i]) redIn[c]!++;
    }
  // A cell mostly covered by text says little about the rest.
  for (let c = 0; c < cols * rows; c++) if (area[c]! >= (CELL * CELL) / 4 && redIn[c]! / area[c]! >= HOT_CELL) hot[c] = 1;
  const seen = new Uint8Array(cols * rows);
  const out: (Hotspot & { pixels: number })[] = [];
  for (let start = 0; start < cols * rows; start++) {
    if (!hot[start] || seen[start]) continue;
    let [x0, y0, x1, y1, r, a] = [cols, rows, 0, 0, 0, 0];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const [cx, cy] = [c % cols, Math.floor(c / cols)];
      [x0, y0, x1, y1] = [Math.min(x0, cx), Math.min(y0, cy), Math.max(x1, cx), Math.max(y1, cy)];
      r += redIn[c]!;
      a += area[c]!;
      for (const [nx, ny] of [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ] as const) {
        const nc = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && hot[nc] && !seen[nc]) {
          seen[nc] = 1;
          stack.push(nc);
        }
      }
    }
    const x = x0 * CELL;
    const y = y0 * CELL;
    out.push({ x, y, width: Math.min(w, (x1 + 1) * CELL) - x, height: Math.min(h, (y1 + 1) * CELL) - y, share: a ? r / a : 0, pixels: r });
  }
  return out
    .sort((p, q) => q.pixels - p.pixels)
    .slice(0, max)
    .map(({ pixels: _, ...hs }) => hs);
}

/** A 2 px red frame around each hotspot, on the difference panel (which starts at `left` in the image). */
function outline(image: PNG, spots: Box[], left: number) {
  const set = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const i = (y * image.width + x) * 4;
    image.data[i] = 220;
    image.data[i + 1] = 38;
    image.data[i + 2] = 38;
    image.data[i + 3] = 255;
  };
  for (const s of spots)
    for (let t = 0; t < 2; t++) {
      for (let x = s.x; x < s.x + s.width; x++) {
        set(left + x, s.y + t);
        set(left + x, s.y + s.height - 1 - t);
      }
      for (let y = s.y; y < s.y + s.height; y++) {
        set(left + s.x + t, y);
        set(left + s.x + s.width - 1 - t, y);
      }
    }
}

/**
 * Mean structural similarity (SSIM) of two same-size pictures' luminance, over 8×8 windows 4 px apart, leaving out
 * windows that are mostly text (where the browser and Figma rasterise glyphs differently). 1 when there's nothing
 * to compare.
 */
export function ssim(a: Uint8Array | Buffer, b: Uint8Array | Buffer, w: number, h: number, inText?: Uint8Array): number {
  const lum = (d: Uint8Array | Buffer, i: number) => 0.299 * d[i * 4]! + 0.587 * d[i * 4 + 1]! + 0.114 * d[i * 4 + 2]!;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const N = 8;
  let total = 0;
  let windows = 0;
  for (let y = 0; y + N <= h; y += 4)
    for (let x = 0; x + N <= w; x += 4) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      let text = 0;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const p = (y + j) * w + x + i;
          if (inText?.[p]) text++;
          const va = lum(a, p);
          const vb = lum(b, p);
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      if (text > (N * N) / 2) continue;
      const n = N * N;
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows++;
    }
  return windows ? total / windows : 1;
}

export function compare(
  browser: PNG,
  figma: PNG,
  text: Box[] = [],
): { mismatch: number; textMismatch: number | null; ssim: number; hotspots: Hotspot[]; image: PNG } {
  const w = Math.max(browser.width, figma.width);
  const h = Math.max(browser.height, figma.height);
  // On white, opaque: Figma exports transparent backgrounds, the browser paints white.
  const pad = (p: PNG) => {
    const out = new PNG({ width: w, height: h });
    out.data.fill(255);
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        const o = (y * w + x) * 4;
        const a = p.data[i + 3]! / 255;
        for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(p.data[i + c]! * a + 255 * (1 - a));
      }
    return out;
  };
  const a = pad(browser);
  const b = pad(figma);
  const diff = new PNG({ width: w, height: h });
  pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.2 });
  // Text boxes, widened by 3 px (glyph runs end at slightly different places).
  const inText = new Uint8Array(w * h);
  for (const t of text)
    for (let y = Math.max(0, Math.floor(t.y - 3)); y < Math.min(h, Math.ceil(t.y + t.height + 3)); y++)
      for (let x = Math.max(0, Math.floor(t.x - 3)); x < Math.min(w, Math.ceil(t.x + t.width + 3)); x++) inText[y * w + x] = 1;
  let outside = 0;
  let inside = 0;
  let textArea = 0;
  const redAt = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const red = diff.data[i * 4] === 255 && diff.data[i * 4 + 1] === 0 && diff.data[i * 4 + 2] === 0;
    if (red) redAt[i] = 1;
    if (inText[i]) {
      textArea++;
      if (red) inside++;
    } else if (red) outside++;
  }
  const spots = hotspots(redAt, inText, w, h);
  // browser | figma | difference, 16 px apart.
  const image = new PNG({ width: w * 3 + 32, height: h });
  image.data.fill(255);
  PNG.bitblt(a, image, 0, 0, w, h, 0, 0);
  PNG.bitblt(b, image, 0, 0, w, h, w + 16, 0);
  PNG.bitblt(diff, image, 0, 0, w, h, 2 * w + 32, 0);
  outline(image, spots, 2 * w + 32);
  return {
    mismatch: outside / (w * h),
    textMismatch: textArea ? inside / textArea : null,
    ssim: Math.round(1000 * ssim(a.data, b.data, w, h, inText)) / 1000,
    hotspots: spots,
    image,
  };
}

/** The worst region's share, 0 without regions. */
const worstRegion = (r: Pick<VerifyRow, "hotspots">) => Math.max(0, ...(r.hotspots ?? []).map((h) => h.share));

/**
 * Each row against the same variant in the previous verify: worse when it's newly flagged, when 1% more of its
 * pixels differ, or when its worst region got 15 points worse; better the other way round. Rows that are new, or
 * that couldn't be compared (no Figma version), get no trend.
 */
export function trends(previous: VerifyRow[], rows: VerifyRow[]): { worse: number; better: number } {
  const before = new Map(previous.map((r) => [`${r.component}|${r.variant}`, r]));
  let worse = 0;
  let better = 0;
  for (const r of rows) {
    const p = before.get(`${r.component}|${r.variant}`);
    if (!p || p.mismatch === null || r.mismatch === null) continue;
    const dm = r.mismatch - p.mismatch;
    const dr = worstRegion(r) - worstRegion(p);
    if ((r.flagged && !p.flagged) || dm > 0.01 || dr > 0.15) {
      r.trend = "worse";
      worse++;
    } else if ((!r.flagged && p.flagged) || dm < -0.01 || dr < -0.15) {
      r.trend = "better";
      better++;
    }
  }
  return { worse, better };
}

export async function verify(args: string[]): Promise<number> {
  const config = requireConfig() as { storybook?: { build?: string; out?: string } };
  const sb = config.storybook ?? {};
  if (!args.includes("--no-build"))
    execSync(sb.build ?? "pnpm build-storybook", { stdio: "ignore", env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" } });
  const registry = JSON.parse(readFileSync(join(dir(), "registry.json"), "utf8")) as RegistryFile;
  const wanted = args.filter((a) => !a.startsWith("--"));
  const components = Object.keys(registry.components).filter((k) => !wanted.length || wanted.includes(k));
  if (wanted.length && !components.length) throw new Error(`not registered: ${wanted.join(", ")} — run codesignflo sync first`);
  // --widths=1280,768,375: pages are also checked at each of these widths, Figma's copy resized to it (its fill,
  // hug and wrap reflowing) against the browser at that window width.
  const widths = (args.find((a) => a.startsWith("--widths="))?.slice(9) ?? "")
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter((x) => x > 0);
  const screens = args.includes("--screens") || widths.length ? Object.entries(registry.screens) : [];

  // Figma side first (one connection), then the browser.
  const figma = await withPlugin({ projectId: requireConfig().projectId }, async (s) => {
    const out: Record<string, string> = await s.call("exportVariants", { setKeys: components }, { timeoutMs: 180_000 });
    for (const [key] of screens) {
      try {
        out[`screen:${key}`] = await s.call<string>("exportNode", { k: `screen:${key}` });
        for (const w of widths) out[`screen:${key}@${w}`] = await s.call<string>("exportNode", { k: `screen:${key}`, width: w });
      } catch {
        // not in Live yet
      }
    }
    return out;
  });

  const folder = join(dir(), "verify");
  // The last verify, to say what changed since (read before its folder is replaced).
  let previous: { at: string; rows: VerifyRow[] } | null = null;
  try {
    previous = JSON.parse(readFileSync(join(folder, "report.json"), "utf8")) as { at: string; rows: VerifyRow[] };
  } catch {
    // the first verify
  }
  rmSync(folder, { recursive: true, force: true });
  const rows: VerifyRow[] = [];
  await withStorybook(resolve(sb.out ?? "storybook-static"), async (page, load) => {
    // At the width the Figma version has: components that fill their container (a footer) then match.
    const shoot = async (story: string, width?: number, windowWidth?: number) => {
      const { error } = await load(story, windowWidth ? { size: { w: windowWidth, h: 900 } } : undefined);
      if (width)
        await page.evaluate((w) => {
          const c = (document.querySelector("[data-cdf-container]") ?? document.querySelector("#storybook-root")) as HTMLElement;
          // The content box: Storybook's root has padding, and a filling component was 32px narrower.
          c.style.boxSizing = "content-box";
          c.style.width = `${w}px`;
        }, width);
      // The story's own container first: "#storybook-root > *" would be the story's wrapper around it.
      const el = (await page.$("[data-cdf-container] > *")) ?? (await page.$("#storybook-root > *"));
      if (!el) throw new Error(`story ${story} rendered nothing`);
      // Snap to whole pixels: at a fractional position every edge is half a pixel off (and the screenshot
      // one pixel larger), which would read as a difference.
      const box = await el.evaluate((e) => {
        const r = e.getBoundingClientRect();
        (e as HTMLElement).style.translate = `${-(r.x % 1)}px ${-(r.y % 1)}px`;
        const at = e.getBoundingClientRect();
        // Every run of text, relative to the element.
        const text: { x: number; y: number; width: number; height: number }[] = [];
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const q of Array.from(range.getClientRects())) text.push({ x: q.x - at.x, y: q.y - at.y, width: q.width, height: q.height });
        }
        return { width: r.width, height: r.height, text };
      });
      const shot = PNG.sync.read(await el.screenshot());
      return { shot, width: Math.round(box.width), height: Math.round(box.height), text: box.text, error };
    };
    /** The element at a region's centre (coordinates relative to the story's root), described for people. */
    const whatIsAt = (_story: string, b: Box) =>
      page.evaluate(
        ({ cx, cy }) => {
          const root = (document.querySelector("[data-cdf-container] > *") ?? document.querySelector("#storybook-root > *")) as HTMLElement;
          const r = root.getBoundingClientRect();
          const el = document.elementFromPoint(r.x + cx, r.y + cy) as HTMLElement | null;
          if (!el || !root.contains(el)) return undefined;
          const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
          const text = (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
          return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}>${text ? ` "${text}"` : ""}`;
        },
        { cx: b.x + b.width / 2, cy: b.y + b.height / 2 },
      );
    const add = async (component: string, variant: string, story: string, figmaKey: string, windowWidth?: number) => {
      const f = figma[figmaKey] ? PNG.sync.read(Buffer.from(figma[figmaKey]!, "base64")) : null;
      // A page at a given width is the window that wide; otherwise at the width Live has.
      const { shot: browser, width: bw, height: bh, text, error } = await shoot(story, windowWidth ? undefined : f?.width, windowWidth);
      const row: VerifyRow = {
        component,
        variant,
        story,
        browser: { width: bw, height: bh },
        figma: f ? { width: f.width, height: f.height } : null,
        mismatch: null,
        flagged: true,
        ...(error ? { storyError: error.split("\n")[0] } : {}),
        ...(windowWidth ? { width: windowWidth } : {}),
      };
      if (f) {
        const { mismatch, textMismatch, ssim: structure, hotspots: spots, image } = compare(browser, f, text);
        // What the browser draws in the middle of each region: its tag, classes and a little text.
        for (const hs of spots) hs.at = await whatIsAt(story, hs).catch(() => undefined);
        if (spots.length) row.hotspots = spots;
        const file = join(folder, component, `${variant.replace(/[^\w=.-]+/g, "_")}.png`);
        mkdirSync(join(folder, component), { recursive: true });
        writeFileSync(file, PNG.sync.write(image));
        row.mismatch = mismatch;
        row.ssim = structure;
        row.textMismatch = textMismatch;
        row.image = relative(process.cwd(), file);
        row.flagged =
          Math.abs(bw - f.width) > SIZE_PX ||
          Math.abs(bh - f.height) > SIZE_PX ||
          mismatch > MISMATCH ||
          (mismatch > MISMATCH_LOW && structure < SSIM_MIN) ||
          spots.some((hs) => hs.share >= HOTSPOT);
      }
      rows.push(row);
    };
    for (const k of components)
      for (const [story, props] of Object.entries(registry.components[k]!.stories)) {
        const name = variantName(props);
        await add(k, name, story, `${k}/${name}`);
      }
    for (const [key, sc] of screens) {
      await add(key, "screen", sc.story, `screen:${key}`);
      for (const w of widths) await add(key, `screen@${w}`, sc.story, `screen:${key}@${w}`, w);
    }
  });

  const change = previous ? trends(previous.rows ?? [], rows) : null;
  mkdirSync(folder, { recursive: true });
  if (previous) writeFileSync(join(folder, "report.previous.json"), `${JSON.stringify(previous, null, 2)}\n`);
  writeFileSync(
    join(folder, "report.json"),
    `${JSON.stringify({ at: new Date().toISOString(), thresholds: { sizePx: SIZE_PX, mismatch: MISMATCH, mismatchLow: MISMATCH_LOW, ssim: SSIM_MIN, hotspot: HOTSPOT }, rows }, null, 2)}\n`,
  );
  for (const r of rows) {
    const size = r.figma ? `${r.browser.width}×${r.browser.height} vs ${r.figma.width}×${r.figma.height}` : "not in Live";
    const pct =
      r.mismatch === null
        ? ""
        : ` ${(100 * r.mismatch).toFixed(1)}% pixels differ${r.textMismatch ? ` (text ${(100 * r.textMismatch).toFixed(0)}%)` : ""}${r.ssim != null ? `, structure ${r.ssim.toFixed(2)}` : ""}`;
    console.log(
      `${r.flagged ? "!" : "✓"} ${`${r.component} ${r.variant}`.padEnd(40)} ${size}${pct}${r.trend ? ` — ${r.trend} than last time` : ""}${r.storyError ? ` — the story's play function failed (${r.storyError}): fix the story, the comparison means nothing until then` : ""}`,
    );
    // The regions that differ most: where to look (boxed in red on the difference image).
    for (const hs of (r.hotspots ?? []).filter((x) => x.share >= HOT_CELL).slice(0, 3))
      console.log(
        `    region ${hs.width}×${hs.height} at ${hs.x},${hs.y}: ${(100 * hs.share).toFixed(0)}% differs${hs.at ? ` — ${hs.at}` : ""}`,
      );
  }
  const flagged = rows.filter((r) => r.flagged).length;
  console.log(
    `${rows.length - flagged}/${rows.length} match (sizes within ${SIZE_PX} px, under ${MISMATCH * 100}% pixels outside text — ${MISMATCH_LOW * 100}% when the structure differs too (SSIM under ${SSIM_MIN}) — and no region over ${HOTSPOT * 100}% different). Images (regions boxed in red): ${relative(process.cwd(), folder)}/`,
  );
  if (change && previous)
    console.log(
      `Since the last verify (${previous.at.slice(0, 16).replace("T", " ")}): ${change.worse} worse, ${change.better} better${change.worse ? " — what got worse is the place to look first" : ""}.`,
    );
  // --strict: fails when anything is flagged, or got worse since the last verify.
  return (flagged || change?.worse) && args.includes("--strict") ? 1 : 0;
}
