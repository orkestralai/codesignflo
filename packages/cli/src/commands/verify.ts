// codesignflo verify [component…] [--screens] [--strict] — does Live look like the code? Each variant story
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
  /** The story's play function failed: the browser shows Storybook's error, not the story. */
  storyError?: string;
  /** Share of pixels inside text boxes that differ (font rasterisation; informative only). */
  textMismatch?: number | null;
  flagged: boolean;
  image?: string;
};

/**
 * Thresholds: sizes within 2 px, under 3% of pixels different outside text. Inside text boxes the browser
 * and Figma rasterise the same font differently (glyph widths differ by fractions of a pixel), so text is
 * measured and reported separately and does not flag a variant on its own.
 */
const SIZE_PX = 2;
const MISMATCH = 0.03;

type Box = { x: number; y: number; width: number; height: number };

export function compare(browser: PNG, figma: PNG, text: Box[] = []): { mismatch: number; textMismatch: number | null; image: PNG } {
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
  for (let i = 0; i < w * h; i++) {
    const red = diff.data[i * 4] === 255 && diff.data[i * 4 + 1] === 0 && diff.data[i * 4 + 2] === 0;
    if (inText[i]) {
      textArea++;
      if (red) inside++;
    } else if (red) outside++;
  }
  // browser | figma | difference, 16 px apart.
  const image = new PNG({ width: w * 3 + 32, height: h });
  image.data.fill(255);
  PNG.bitblt(a, image, 0, 0, w, h, 0, 0);
  PNG.bitblt(b, image, 0, 0, w, h, w + 16, 0);
  PNG.bitblt(diff, image, 0, 0, w, h, 2 * w + 32, 0);
  return { mismatch: outside / (w * h), textMismatch: textArea ? inside / textArea : null, image };
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
  const screens = args.includes("--screens") ? Object.entries(registry.screens) : [];

  // Figma side first (one connection), then the browser.
  const figma = await withPlugin({ projectId: requireConfig().projectId }, async (s) => {
    const out: Record<string, string> = await s.call("exportVariants", { setKeys: components }, { timeoutMs: 180_000 });
    for (const [key] of screens) {
      try {
        out[`screen:${key}`] = await s.call<string>("exportNode", { k: `screen:${key}` });
      } catch {
        // not in Live yet
      }
    }
    return out;
  });

  const folder = join(dir(), "verify");
  rmSync(folder, { recursive: true, force: true });
  const rows: VerifyRow[] = [];
  await withStorybook(resolve(sb.out ?? "storybook-static"), async (page, load) => {
    // At the width the Figma version has: components that fill their container (a footer) then match.
    const shoot = async (story: string, width?: number) => {
      const { error } = await load(story);
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
    const add = async (component: string, variant: string, story: string, figmaKey: string) => {
      const f = figma[figmaKey] ? PNG.sync.read(Buffer.from(figma[figmaKey]!, "base64")) : null;
      const { shot: browser, width: bw, height: bh, text, error } = await shoot(story, f?.width);
      const row: VerifyRow = {
        component,
        variant,
        story,
        browser: { width: bw, height: bh },
        figma: f ? { width: f.width, height: f.height } : null,
        mismatch: null,
        flagged: true,
        ...(error ? { storyError: error.split("\n")[0] } : {}),
      };
      if (f) {
        const { mismatch, textMismatch, image } = compare(browser, f, text);
        const file = join(folder, component, `${variant.replace(/[^\w=.-]+/g, "_")}.png`);
        mkdirSync(join(folder, component), { recursive: true });
        writeFileSync(file, PNG.sync.write(image));
        row.mismatch = mismatch;
        row.textMismatch = textMismatch;
        row.image = relative(process.cwd(), file);
        row.flagged = Math.abs(bw - f.width) > SIZE_PX || Math.abs(bh - f.height) > SIZE_PX || mismatch > MISMATCH;
      }
      rows.push(row);
    };
    for (const k of components)
      for (const [story, props] of Object.entries(registry.components[k]!.stories)) {
        const name = variantName(props);
        await add(k, name, story, `${k}/${name}`);
      }
    for (const [key, sc] of screens) await add(key, "screen", sc.story, `screen:${key}`);
  });

  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "report.json"),
    `${JSON.stringify({ at: new Date().toISOString(), thresholds: { sizePx: SIZE_PX, mismatch: MISMATCH }, rows }, null, 2)}\n`,
  );
  for (const r of rows) {
    const size = r.figma ? `${r.browser.width}×${r.browser.height} vs ${r.figma.width}×${r.figma.height}` : "not in Live";
    const pct =
      r.mismatch === null
        ? ""
        : ` ${(100 * r.mismatch).toFixed(1)}% pixels differ${r.textMismatch ? ` (text ${(100 * r.textMismatch).toFixed(0)}%)` : ""}`;
    console.log(
      `${r.flagged ? "!" : "✓"} ${`${r.component} ${r.variant}`.padEnd(40)} ${size}${pct}${r.storyError ? ` — the story's play function failed (${r.storyError}): fix the story, the comparison means nothing until then` : ""}`,
    );
  }
  const flagged = rows.filter((r) => r.flagged).length;
  console.log(
    `${rows.length - flagged}/${rows.length} match (sizes within ${SIZE_PX} px, under ${MISMATCH * 100}% pixels outside text). Images: ${relative(process.cwd(), folder)}/`,
  );
  return flagged && args.includes("--strict") ? 1 : 0;
}
