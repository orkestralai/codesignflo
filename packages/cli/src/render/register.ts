// Registers the whole Storybook automatically: every component (story group) and every page.
// Variants come from the component's real props — booleans and enums whose value differs between its
// stories, plus slot props (React nodes) that some stories fill and others don't. Free-text props
// (title, price, label…) are example data, never variants: a "version" the designer can target must be
// something the code can express as a condition (first designer test, M2/M3).
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { keyOfTitle } from "@codesignflo/core";
import type { Page } from "playwright";

export type RegistryEntry = {
  module: string;
  title: string;
  files: string[];
  stories: Record<string, Record<string, string>>;
  /** Stories that differ from a variant only in example data: example story id → variant story id. */
  examples?: Record<string, string>;
};
export type AutoRegistry = {
  generated: string;
  components: Record<string, RegistryEntry>;
  screens: Record<string, { story: string; title: string; files: string[] }>;
};

type ArgType = { type?: { name?: string }; options?: unknown[]; control?: unknown; table?: { defaultValue?: { summary?: string } } };
type Extracted = Record<
  string,
  {
    id: string;
    title: string;
    name: string;
    args: Record<string, unknown>;
    argTypes: Record<string, ArgType>;
    parameters?: { layout?: string };
  }
>;
type IndexJson = { entries: Record<string, { id: string; type: string; title: string; importPath: string }> };

/** "ProductCard" → "product-card" (shared with the plugin, so designer names give the same keys). */
export const keyOf = keyOfTitle;

const pagesTitle = (title: string) => /^(pages|screens)(\/|$)/i.test(title);
const isScreen = (title: string, layout?: string) => pagesTitle(title) || layout === "fullscreen";

/**
 * Source files of a component: the files next to its stories file named like it (Button.tsx,
 * Button.module.css). For a page story, `stem` is the page's name from the story id ("cart-page" → Cart…).
 */
function filesNear(projectDir: string, importPath: string, stemOverride?: string): string[] {
  const rel = importPath.replace(/^\.\//, "");
  const folder = dirname(rel);
  const stem = stemOverride ?? basename(rel).replace(/\.stories\.[jt]sx?$/, "");
  return readdirSync(join(projectDir, folder))
    .filter((f) => !/\.(stories|test|spec)\.[jt]sx?$/.test(f) && /\.(tsx?|jsx?|css|scss|less)$/.test(f))
    .filter((f) => f.toLowerCase().startsWith(stem.toLowerCase()) || (!stemOverride && f.startsWith("index.")))
    .map((f) => join(folder, f))
    .sort();
}

export async function register(page: Page, storybookDir: string, projectDir: string): Promise<AutoRegistry> {
  const index = JSON.parse(readFileSync(join(storybookDir, "index.json"), "utf8")) as IndexJson;
  const extracted = (await page.evaluate(async () => {
    const preview = (window as unknown as { __STORYBOOK_PREVIEW__: { extract: () => Promise<unknown> } }).__STORYBOOK_PREVIEW__;
    const all = (await preview.extract()) as Record<string, { args: Record<string, unknown> } & Record<string, unknown>>;
    // Make args serializable: functions dropped, React nodes reduced to "present".
    for (const s of Object.values(all))
      s.args = Object.fromEntries(
        Object.entries(s.args)
          .filter(([, v]) => typeof v !== "function")
          .map(([k, v]) => [k, v !== null && typeof v === "object" ? "__node__" : v]),
      );
    return JSON.parse(
      JSON.stringify(all, (k, v) => (k === "component" || k === "render" || k === "decorators" || k === "loaders" ? undefined : v)),
    );
  })) as Extracted;

  const stories = Object.values(index.entries).filter((e) => e.type === "story");
  const byTitle = new Map<string, typeof stories>();
  for (const s of stories) byTitle.set(s.title, [...(byTitle.get(s.title) ?? []), s]);

  const out: AutoRegistry = { generated: "codesignflo sync — derived from Storybook; do not edit", components: {}, screens: {} };
  for (const [title, group] of [...byTitle].sort(([a], [b]) => a.localeCompare(b))) {
    const first = extracted[group[0]!.id];
    if (!first) continue;
    const key = keyOf(title);
    const files = filesNear(projectDir, group[0]!.importPath);
    if (isScreen(title, first.parameters?.layout)) {
      // Full-screen layout alone makes a page: say so (a component story that sets it silently became one).
      if (!pagesTitle(title))
        console.error(
          `${title}: treated as a page (its stories use layout "fullscreen"); title it "Pages/…" to keep it, or drop the layout to make it a component`,
        );
      for (const s of group) {
        const storyName = s.id.split("--")[1] ?? "";
        // "cart-page" → files of the Cart page next to the stories (or the stories file's own stem).
        const pageFiles = filesNear(projectDir, s.importPath, storyName.split("-")[0]);
        // A page title with one story ("Pages/Access And Domains Screen Page" → its "Page" story) is that page:
        // its story's name isn't part of the key (it made pages.x-page.page, which no design matched).
        const single = group.length === 1 && key !== "pages";
        out.screens[single ? key : keyOf(`${title}/${storyName}`).replace(/\.default$/, "")] = {
          story: s.id,
          title,
          files: pageFiles.length ? pageFiles : files,
        };
      }
      continue;
    }
    // Candidate variant props: booleans, enums, and slots (React nodes).
    const argTypes = first.argTypes;
    const kind = (name: string): "bool" | "enum" | "slot" | null => {
      const t = argTypes[name]?.type?.name;
      if (t === "boolean") return "bool";
      if (t === "enum" || (argTypes[name]?.options?.length ?? 0) > 0) return "enum";
      if (t === "other" || group.some((s) => extracted[s.id]?.args[name] === "__node__")) return "slot";
      return null;
    };
    // A story that leaves an enum prop out shows the component's default: that's its value (an empty value
    // made a version Figma rejects, "variant=", and stopped the whole update). The declared default, else
    // the story's own name when it is one of the options ("Primary" → primary), else "default".
    const defaultOf = (name: string, storyId?: string) => {
      const declared = argTypes[name]?.table?.defaultValue?.summary?.replace(/^["'`]|["'`]$/g, "");
      if (declared && declared !== "undefined") return declared;
      const story = storyId?.split("--")[1]?.toLowerCase();
      const options = (argTypes[name]?.options ?? []).map(String);
      return story && options.some((o) => o.toLowerCase() === story) ? options.find((o) => o.toLowerCase() === story)! : "default";
    };
    const value = (args: Record<string, unknown>, name: string, k: "bool" | "enum" | "slot", storyId?: string) =>
      k === "slot"
        ? String(args[name] === "__node__")
        : k === "bool"
          ? String(args[name] === true)
          : args[name] === undefined || args[name] === ""
            ? defaultOf(name, storyId)
            : String(args[name]);
    const names = [...new Set(group.flatMap((s) => [...Object.keys(extracted[s.id]?.args ?? {}), ...Object.keys(argTypes)]))].sort();
    const varying = names.filter((n) => {
      const k = kind(n);
      return k !== null && new Set(group.map((s) => value(extracted[s.id]?.args ?? {}, n, k, s.id))).size > 1;
    });
    const entry: RegistryEntry = {
      module: basename(files.find((f) => /\.[jt]sx?$/.test(f)) ?? title).replace(/\.[jt]sx?$/, ""),
      title,
      files,
      stories: {},
    };
    const seen = new Map<string, string>();
    for (const s of group) {
      const args = extracted[s.id]?.args ?? {};
      const props = Object.fromEntries(varying.map((n) => [n, value(args, n, kind(n)!, s.id)]));
      const sig = JSON.stringify(props);
      // Stories that differ only in example data are the same version: keep the first as the variant,
      // the others as its examples (they show e.g. that a title wraps).
      const variantStory = seen.get(sig);
      if (variantStory) {
        entry.examples = { ...(entry.examples ?? {}), [s.id]: variantStory };
        continue;
      }
      seen.set(sig, s.id);
      entry.stories[s.id] = varying.length ? props : { story: s.id.split("--")[1] ?? "default" };
    }
    out.components[key] = entry;
  }
  return out;
}
