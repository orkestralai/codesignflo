// Renders Storybook stories in headless Chromium and extracts one IR per story (ported from spike S4/S7).
// Serves the static Storybook build itself, so nothing else has to be running.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { extname, join } from "node:path";
import { hash, type IRNode, type IRStory } from "@codesignflo/core";
import { chromium, type Frame, type Page } from "playwright";
import { VERSION } from "../version.js";
import { extractInPage } from "./extract-in-page.js";
import { DEFAULT_DATE, type RawStoryOptions, renderOptions, type StoryRenderOptions } from "./options.js";
import { type AutoRegistry, register } from "./register.js";
import { droppedTexts, pageTextsInPage } from "./text-inventory.js";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
};

/** What a render depends on besides the code: two different setups can draw the same code slightly differently. */
/** Where a sync rendered: the machine, the browser, Node, and the CLI version that ran (shown by status). */
export type RenderSetup = { os: string; browser: string; node: string; cli?: string };
let lastSetup: RenderSetup | null = null;
export const renderSetup = () => lastSetup;

/** The window when neither the story nor a designer's frame gives a size. */
const DEFAULT_SIZE = { w: 1200, h: 900 };
/** fullHeight grows the window at most this tall. */
const MAX_HEIGHT = 20_000;

/** Loads a story: at `size` when given (the designer's frame), else the story's own size. */
/** Loads a story at its size and settles it; says what went wrong when its play function failed. */
export type Load = (id: string, opts?: { size?: { w: number; h: number } }) => Promise<{ error?: string }>;

/** Serves the static Storybook build: its files, and a folder as its index.html. */
export function serveStatic(staticDir: string): RequestListener {
  return (req, res) => {
    let path = join(staticDir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    // A folder is its index.html, as any web server serves it (a story's iframe loading /embed/<token> from
    // Storybook's public files was a 404: the widget drawn blank).
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path) || statSync(path).isDirectory()) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
    createReadStream(path).pipe(res);
  };
}

/**
 * Opens the static Storybook build in headless Chromium and runs `fn` with a page that can load any story.
 * `load(id)` navigates to a story with its render options (size, clock, fullHeight) and waits for it to
 * render with its fonts.
 */
export async function withStorybook<T>(staticDir: string, fn: (page: Page, load: Load) => Promise<T>): Promise<T> {
  if (!existsSync(join(staticDir, "index.json"))) throw new Error(`no Storybook build in ${staticDir} (expected index.json)`);
  const server = createServer(serveStatic(staticDir));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch().catch((e: Error) => {
    server.close();
    throw new Error(`could not start Chromium (${e.message.split("\n")[0]}). Install it once with: npx playwright install chromium`);
  });
  try {
    lastSetup = {
      os: `${process.platform}-${process.arch}`,
      browser: `chromium ${browser.version()}`,
      node: process.versions.node.split(".")[0]!,
      cli: VERSION,
    };
    // The same everywhere: language, time zone, a fixed clock and fixed "random" numbers, so stories that
    // show dates or random data draw the same on every machine and every run.
    const page = await browser.newPage({
      viewport: { width: DEFAULT_SIZE.w, height: DEFAULT_SIZE.h },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      locale: "en-US",
      timezoneId: "UTC",
    });
    await page.clock.setFixedTime(DEFAULT_DATE);
    await page.addInitScript(() => {
      // tsx/esbuild may wrap functions in __name(); define it so page.evaluate can run the extractor.
      (globalThis as unknown as { __name: unknown }).__name = (f: unknown) => f;
      let seed = 42;
      Math.random = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed - 1) / 2147483646;
      };
    });
    // Each story's render options, read once from Storybook (parameters from preview, component and story).
    let options: Map<string, StoryRenderOptions> | null = null;
    const optionsOf = async (id: string): Promise<StoryRenderOptions> => {
      if (!options) {
        if (!page.url().includes("/iframe.html")) {
          await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`);
          await page.waitForSelector("#storybook-root > *");
        }
        const raw = await page.evaluate(async () => {
          type Preview = {
            extract: () => Promise<Record<string, { parameters?: Record<string, unknown>; globals?: Record<string, unknown> }>>;
            storyStoreValue?: { projectAnnotations?: { initialGlobals?: Record<string, unknown>; globals?: Record<string, unknown> } };
          };
          const preview = (window as unknown as { __STORYBOOK_PREVIEW__: Preview }).__STORYBOOK_PREVIEW__;
          const all = await preview.extract();
          const project = preview.storyStoreValue?.projectAnnotations;
          const keep = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
          return {
            projectGlobals: { viewport: keep((project?.initialGlobals ?? project?.globals)?.viewport) },
            stories: Object.fromEntries(
              Object.entries(all).map(([sid, st]) => [
                sid,
                {
                  parameters: { viewport: keep(st.parameters?.viewport), codesignflo: keep(st.parameters?.codesignflo) },
                  globals: { viewport: keep(st.globals?.viewport), viewportRotated: keep(st.globals?.viewportRotated) },
                },
              ]),
            ),
          };
        });
        options = new Map(
          Object.entries(raw.stories as Record<string, RawStoryOptions>).map(([sid, r]) => {
            try {
              return [sid, renderOptions(r, raw.projectGlobals)];
            } catch (e) {
              throw new Error(`story ${sid}: ${(e as Error).message}`);
            }
          }),
        );
      }
      return options.get(id) ?? {};
    };
    const load: Load = async (id, opts = {}) => {
      const o = await optionsOf(id);
      const size = opts.size ?? o.size ?? DEFAULT_SIZE;
      await page.clock.setFixedTime(o.date ?? DEFAULT_DATE);
      await page.setViewportSize({ width: Math.round(size.w), height: Math.round(size.h) });
      // A story with a play function (clicking a modal to its fourth step, filling a form) is what it shows
      // once that has run: wait for Storybook to say the story is done, then for the page to settle. A play
      // function that failed is run once more (its query timed out on a busy machine), then reported: what
      // the page shows is where it stopped, not the story.
      let error: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Every story starts as a first visit: what an earlier story saved (an app's history in
        // localStorage, a cookie) would otherwise change what this one shows, by the order they ran in.
        await page.context().clearCookies();
        if (page.url().startsWith(base))
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
        await page.goto(`${base}/iframe.html?id=${id}&viewMode=story`);
        await page.waitForSelector("#storybook-root > *", { timeout: 20_000 }).catch(() => undefined);
        await page
          .waitForFunction(
            () => {
              const r = (globalThis as { __STORYBOOK_PREVIEW__?: { currentRender?: { phase?: string } } }).__STORYBOOK_PREVIEW__
                ?.currentRender;
              return !r?.phase || ["completed", "played", "errored", "aborted", "finished"].includes(r.phase);
            },
            undefined,
            { timeout: 20_000 },
          )
          .catch(() => undefined);
        error = await page.evaluate(() =>
          document.body.classList.contains("sb-show-errordisplay")
            ? (document.querySelector("#error-message") as HTMLElement | null)?.innerText.trim() || "the story failed"
            : undefined,
        );
        if (!error) break;
      }
      await settle(page);
      // Frames in the story (a widget in its own iframe): loaded and settled too, so they're drawn.
      for (const f of page.mainFrame().childFrames()) {
        await f.waitForLoadState("load", { timeout: 15_000 }).catch(() => undefined);
        await f.waitForSelector("#storybook-root > *, body > *", { timeout: 15_000 }).catch(() => undefined);
        await settle(f).catch(() => undefined);
      }
      if (o.fullHeight) await growToFit(page, Math.round(size.w), Math.round(size.h));
      await coverPage(page);
      return error ? { error } : {};
    };
    return await fn(page, load);
  } finally {
    await browser.close();
    server.close();
  }
}

/** Waits until the story stops changing (animations, late state updates), then for its fonts and pictures. */
async function settle(page: Page | Frame) {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        // Settled: nothing changed in the story for a moment (animations and late state updates).
        let timer = setTimeout(finish, 250);
        const stop = setTimeout(finish, 4000);
        const watch = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(finish, 250);
        });
        watch.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        function finish() {
          watch.disconnect();
          clearTimeout(timer);
          clearTimeout(stop);
          done();
        }
      }),
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Pictures too (they are rasterised into the IR), the lazy ones included: loaded now, each given a few seconds
  // so one that never arrives can't hold up the story.
  await page.evaluate(picturesLoadedInPage);
}

/**
 * Runs in the page: lazy pictures load now (loading="lazy" made eager, a data-src the page would set on scroll put
 * in place, the page scrolled through once so observers fire), then every picture, CSS background picture and
 * video frame is waited for, at most 3 s each, and pictures decoded so they can be drawn.
 */
export async function picturesLoadedInPage(): Promise<void> {
  const within = (p: Promise<unknown>, ms = 3000) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
  for (const i of Array.from(document.images)) {
    if (i.loading === "lazy") i.loading = "eager";
    const lazySrc = i.dataset.src ?? i.dataset.lazySrc;
    if (lazySrc && (!i.getAttribute("src") || i.getAttribute("src")?.startsWith("data:"))) i.src = lazySrc;
    if (i.dataset.srcset && !i.srcset) i.srcset = i.dataset.srcset;
  }
  const height = document.documentElement.scrollHeight;
  if (height > innerHeight) {
    for (let y = 0; y < height; y += innerHeight) {
      scrollTo(0, y);
      await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    }
    scrollTo(0, 0);
  }
  // Background pictures, kept where the extractor finds them (`__cdfPictures`, by address) to draw them.
  const backgrounds = new Set<string>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg.includes("url(")) continue;
    for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) backgrounds.add(new URL(m[1]!, location.href).href);
  }
  const w = window as unknown as { __cdfPictures?: Record<string, HTMLImageElement> };
  w.__cdfPictures ??= {};
  const kept = w.__cdfPictures;
  await Promise.all([
    ...Array.from(document.images).map((i) =>
      within(
        i.complete
          ? i.decode()
          : new Promise((r) => {
              i.addEventListener("load", r, { once: true });
              i.addEventListener("error", r, { once: true });
            }).then(() => i.decode()),
      ),
    ),
    ...[...backgrounds].map((src) => {
      const i = new Image();
      i.src = src;
      return within(i.decode().then(() => (kept[src] ??= i)));
    }),
    // Posters, kept like background pictures (drawn when the video shows no frame).
    ...Array.from(document.querySelectorAll("video")).flatMap((v) => {
      if (!v.poster) return [];
      const i = new Image();
      i.src = v.poster;
      return [within(i.decode().then(() => (kept[new URL(v.poster, location.href).href] ??= i)))];
    }),
    ...Array.from(document.querySelectorAll("video")).map((v) => {
      if (v.readyState >= 2 || (!v.currentSrc && !v.querySelector("source") && !v.src)) return null;
      v.preload = "auto";
      return within(new Promise((r) => v.addEventListener("loadeddata", r, { once: true })));
    }),
  ]);
}

/**
 * fullHeight: grows the window's height until no scrolling panel hides content (an app shell 100vh tall whose
 * main panel scrolls), so the layout is read with everything showing. The page's own height needs nothing: it
 * is read in full at any window. A step that frees nothing is undone (a list capped at a fixed height, or a
 * page that just grows with the window), so the window doesn't grow for content it can't reveal.
 */
/**
 * An overlay fixed to the window (a modal and its backdrop, a drawer) on a page taller than the window: the
 * window grows to the whole page, so the overlay covers the page Live shows (as a full-page screenshot draws
 * it) instead of its first screen, with the modal centred on it.
 */
export async function coverPage(page: Page) {
  const vp = page.viewportSize();
  if (!vp) return;
  const full = await page.evaluate(() => {
    const overlay = [...document.querySelectorAll<HTMLElement>("#storybook-root *, body > *")].some((e) => {
      if (getComputedStyle(e).position !== "fixed") return false;
      const r = e.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.5;
    });
    return overlay ? Math.ceil(document.documentElement.scrollHeight) : 0;
  });
  if (full > vp.height + 1) {
    await page.setViewportSize({ width: vp.width, height: Math.min(full, MAX_HEIGHT) });
    await settle(page);
  }
}

export async function growToFit(page: Page, width: number, height: number) {
  const hidden = () =>
    page.evaluate(() => {
      let most = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        if (el === document.documentElement || el === document.body || el.scrollHeight <= el.clientHeight + 1) continue;
        if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) most = Math.max(most, el.scrollHeight - el.clientHeight);
      }
      return Math.ceil(most);
    });
  let h = height;
  let now = await hidden();
  for (let round = 0; round < 5 && now > 1 && h < MAX_HEIGHT; round++) {
    const next = Math.min(MAX_HEIGHT, h + now);
    await page.setViewportSize({ width, height: next });
    await settle(page);
    const after = await hidden();
    if (after >= now - 1) {
      await page.setViewportSize({ width, height: h });
      await settle(page);
      return;
    }
    h = next;
    now = after;
  }
}

/** Registers everything in Storybook, then extracts every variant story and every page. */
export async function renderStorybook(
  staticDir: string,
  projectDir: string,
  /** Page key → the size of the designer's design: the page is rendered at it, so the two compare. */
  sizes: Record<string, { w: number; h: number }> = {},
): Promise<{
  registry: AutoRegistry;
  irs: Map<string, IRStory>;
  images: Map<string, string>;
  failed: Map<string, string>;
  /** Page story → the browser's screenshot of it (a ref into `images`, its size), shown beside the Live page. */
  shots: Map<string, { ref: string; w: number; h: number }>;
  /** Story → text it shows that the extractor didn't read (Live won't have it). */
  dropped: Map<string, string[]>;
  /** Web fonts (@font-face) the stories' texts use: Figma needs each installed to draw Live as the app. */
  webFonts: string[];
}> {
  return withStorybook(staticDir, async (page, load) => {
    const index = JSON.parse(readFileSync(join(staticDir, "index.json"), "utf8")) as { entries: Record<string, { type: string }> };
    const firstStory = Object.entries(index.entries).find(([, e]) => e.type === "story")?.[0];
    if (!firstStory) throw new Error("Storybook has no stories");
    await load(firstStory);
    const registry = await register(page, staticDir, projectDir);
    const ids = [
      ...Object.values(registry.components).flatMap((c) => [...Object.keys(c.stories), ...Object.keys(c.examples ?? {})]),
      ...Object.values(registry.screens).map((s) => s.story),
    ];
    const irs = new Map<string, IRStory>();
    /** Stories whose play function failed: Live shows where they stopped. */
    const failed = new Map<string, string>();
    // Pictures by content hash: each is uploaded to Figma once, the IR keeps only the reference.
    const images = new Map<string, string>();
    const refs = (n: IRNode) => {
      if (n.image?.png) {
        const ref = hash(n.image.png);
        images.set(ref, n.image.png);
        n.image = { ref };
      }
      if (n.background?.png) {
        const ref = hash(n.background.png);
        images.set(ref, n.background.png);
        n.background = { ref };
      }
      for (const c of n.children ?? []) refs(c);
    };
    const shots = new Map<string, { ref: string; w: number; h: number }>();
    /** Text each story shows that the extractor didn't read (Live won't have it): CoDesignFlo gaps. */
    const dropped = new Map<string, string[]>();
    const webFonts = new Set<string>();
    const familiesOf = (n: IRNode, out: Set<string>) => {
      if (n.text?.fontFamily) out.add(n.text.fontFamily);
      for (const c of n.children ?? []) familiesOf(c, out);
      return out;
    };
    const pages = new Set(Object.values(registry.screens).map((s) => s.story));
    const sizeOf = new Map(Object.entries(registry.screens).flatMap(([key, s]) => (sizes[key] ? [[s.story, sizes[key]!] as const] : [])));
    for (const id of [...new Set(ids)].sort()) {
      // The designer's frame wins; else the story's own size (Storybook's viewport), else the default.
      const { error } = await load(id, { size: sizeOf.get(id) });
      if (error) failed.set(id, error);
      // Before extracting (it measures the page at other widths): the page as it's drawn.
      if (pages.has(id)) {
        const shot = await screenshot(page).catch(() => null);
        if (shot) {
          const ref = hash(shot.jpeg);
          images.set(ref, shot.jpeg);
          shots.set(id, { ref, w: shot.w, h: shot.h });
        }
      }
      // A story that can't be read is reported and left out; it doesn't stop the others.
      let root: IRNode;
      try {
        root = await extractPage(page);
      } catch (e) {
        failed.set(id, `${UNREADABLE}${(e as Error).message.split("\n")[0]}`);
        continue;
      }
      refs(root);
      irs.set(id, { story: id, root });
      const shown = await page.evaluate(pageTextsInPage).catch(() => [] as string[]);
      const missing = droppedTexts(shown, root);
      if (missing.length) dropped.set(id, missing);
      const loaded = await page
        .evaluate(() =>
          Array.from(document.fonts ?? []).flatMap((f) => (f.status === "loaded" ? [f.family.replace(/["']/g, "").trim()] : [])),
        )
        .catch(() => [] as string[]);
      for (const f of familiesOf(root, new Set())) if (loaded.some((l) => l.toLowerCase() === f.toLowerCase())) webFonts.add(f);
    }
    // What's left of the registry without them: a component without any readable story isn't one this time.
    for (const [key, c] of Object.entries(registry.components)) {
      for (const id of Object.keys(c.stories)) if (!irs.has(id)) delete c.stories[id];
      for (const [ex, v] of Object.entries(c.examples ?? {})) if (!irs.has(ex) || !irs.has(v)) delete c.examples![ex];
      if (!Object.keys(c.stories).length) delete registry.components[key];
    }
    for (const [key, sc] of Object.entries(registry.screens)) if (!irs.has(sc.story)) delete registry.screens[key];
    return { registry, irs, images, failed, shots, dropped, webFonts: [...webFonts].sort() };
  });
}

/** How a story that couldn't be read is reported in `failed` (as opposed to a play function that failed). */
export const UNREADABLE = "couldn't be read: ";

/**
 * The story as an IR tree, with what its iframes show inside them (a chat widget in its own frame): each frame
 * read the same way and placed in its iframe's layer. A frame that can't be read (another site's) stays empty.
 */
export async function extractPage(page: Page): Promise<IRNode> {
  await foreignPictures(page);
  const root = await page.evaluate(extractInPage);
  const holders: IRNode[] = [];
  const find = (n: IRNode) => {
    if (n.iframe !== undefined) holders.push(n);
    for (const c of n.children ?? []) find(c);
  };
  find(root);
  if (!holders.length) return root;
  const iframes = await page.$$("iframe");
  for (const holder of holders) {
    const frame = await iframes[holder.iframe!]?.contentFrame();
    if (!frame) continue;
    await foreignPictures(frame).catch(() => undefined);
    const inner = await frame.evaluate(extractInPage).catch(() => null);
    if (!inner) continue;
    // Placed from the iframe's top-left (the frame's own page starts there), filling it.
    const shift = (n: IRNode) => {
      if (n.at) n.at = { x: n.at.x + (holder.at?.x ?? 0), y: n.at.y + (holder.at?.y ?? 0) };
      for (const c of n.children ?? []) shift(c);
    };
    shift(inner);
    inner.width = holder.width;
    inner.height = holder.height;
    inner.sizing = { w: "fill", h: "fill" };
    holder.children = [inner];
    holder.clip = true;
  }
  return root;
}

/**
 * Pictures from other sites (a CDN, avatars, stock photos): the page can't read their pixels (a canvas drawing them
 * is "tainted"), so Live showed a placeholder. Fetched here instead, as the browser would, and handed to the page
 * as data URLs it can draw (`__cdfPictures`, by address), so they're rasterised like the page's own.
 */
export async function foreignPictures(page: Page | Frame): Promise<number> {
  const urls = await page.evaluate(() => {
    const out = new Set<string>();
    const foreign = (u: string) => {
      try {
        const x = new URL(u, location.href);
        return (x.protocol === "http:" || x.protocol === "https:") && x.origin !== location.origin;
      } catch {
        return false;
      }
    };
    for (const i of Array.from(document.images))
      if (i.currentSrc && foreign(i.currentSrc)) out.add(new URL(i.currentSrc, location.href).href);
    for (const v of Array.from(document.querySelectorAll("video")))
      if (v.poster && foreign(v.poster)) out.add(new URL(v.poster, location.href).href);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *")))
      for (const m of getComputedStyle(el).backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g))
        if (foreign(m[1]!)) out.add(new URL(m[1]!, location.href).href);
    return [...out].slice(0, 100);
  });
  if (!urls.length) return 0;
  const request = "request" in page ? page.request : page.page().request;
  const got: [string, string][] = [];
  await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await request.get(u, { timeout: 10_000 });
        const type = (r.headers()["content-type"] ?? "").split(";")[0]!.trim();
        if (!r.ok() || !type.startsWith("image/")) return;
        const body = await r.body();
        if (body.length <= 15_000_000) got.push([u, `data:${type};base64,${body.toString("base64")}`]);
      } catch {
        // unreachable from here too: the placeholder stays
      }
    }),
  );
  return page.evaluate(async (pairs) => {
    const w = window as unknown as { __cdfPictures?: Record<string, HTMLImageElement> };
    w.__cdfPictures ??= {};
    const into = w.__cdfPictures;
    await Promise.all(
      pairs.map(async ([u, data]) => {
        const i = new Image();
        i.src = data;
        try {
          await i.decode();
          into[u] = i;
        } catch {
          // a format the browser can't decode from bytes alone
        }
      }),
    );
    return Object.keys(into).length;
  }, got);
}

/** The story's root element as the browser draws it (what Live builds its page from), JPEG base64. */
export async function screenshot(page: Page): Promise<{ jpeg: string; w: number; h: number } | null> {
  const el = (
    await page.evaluateHandle(() => {
      let c = document.querySelector("[data-cdf-container], [data-cdl-container]") ?? document.querySelector("#storybook-root");
      // The innermost of nested wrappers (as extractInPage reads it).
      while (c?.firstElementChild?.matches("[data-cdf-container], [data-cdl-container]")) c = c.firstElementChild;
      return c?.firstElementChild ?? null;
    })
  ).asElement();
  // The page as it first shows, not scrolled: an element screenshot scrolls a tall page to capture it, and
  // what's sticky moved with it (a sidebar drawn halfway down the page). Captured beyond the window instead.
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = await el?.boundingBox();
  if (!el || !box || box.width < 1 || box.height < 1) return null;
  const jpeg = (
    await page.screenshot({ type: "jpeg", quality: 82, fullPage: true, clip: box, animations: "disabled", caret: "hide" })
  ).toString("base64");
  return { jpeg, w: Math.round(box.width), h: Math.round(box.height) };
}
