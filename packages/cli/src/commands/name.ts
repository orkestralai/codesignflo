// codesignflo name — gives every unnamed element of a registered component (or page) a semantic layer
// name in code, as a data-cdf attribute, so designer and developer never have to name layers by hand
// (brief §3.2b). Rendering finds elements with no data-cdf and no CSS-module class; Claude Code adds
// the names, limited to the files that own those elements; a re-render confirms nothing is left.
import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { IRNode } from "@codesignflo/core";
import { requireConfig } from "../project.js";
import { renderStorybook } from "../render/render.js";

/** Shared vocabulary for common roles (brief §3.2b); teams can extend it in config ("vocabulary"). */
export const VOCABULARY = [
  "header",
  "body",
  "footer",
  "title",
  "subtitle",
  "label",
  "description",
  "price",
  "total",
  "summary",
  "row",
  "list",
  "item",
  "image",
  "media",
  "icon",
  "logo",
  "nav",
  "link",
  "actions",
  "badge",
  "divider",
  "value",
  "step",
  "content",
  "meta",
];

type Unnamed = { owner: string; files: string[]; path: string; tag: string; text?: string };

/** Unnamed elements in a tree, stopping at nested components (their own registration names them). */
function collect(root: IRNode, owner: string, files: string[]): Unnamed[] {
  const out: Unnamed[] = [];
  const walk = (n: IRNode, path: string, isRoot: boolean) => {
    if (!isRoot && n.component) return;
    if (n.unnamed) out.push({ owner, files, path, tag: n.name, ...(n.text ? { text: n.text.characters.slice(0, 40) } : {}) });
    for (const c of n.children ?? []) walk(c, `${path} › ${c.name}`, false);
  };
  walk(root, root.name, true);
  return out;
}

async function find(sbOut: string): Promise<Unnamed[]> {
  const { registry, irs } = await renderStorybook(sbOut, process.cwd());
  return unnamedIn(registry, irs);
}

/**
 * The unnamed elements of the registered components and pages, once each (sync's count uses this too: it
 * counted every story's whole tree, nested components included, and said "2 without a name" where
 * `name --check` found none).
 */
export function unnamedIn(
  registry: {
    components: Record<string, { stories: Record<string, unknown>; files: string[] }>;
    screens: Record<string, { story: string; files: string[] }>;
  },
  irs: Map<string, { root: IRNode }>,
): Unnamed[] {
  const found: Unnamed[] = [];
  for (const [key, c] of Object.entries(registry.components))
    for (const story of Object.keys(c.stories)) {
      const ir = irs.get(story);
      if (ir) found.push(...collect(ir.root, key, c.files));
    }
  for (const [key, sc] of Object.entries(registry.screens)) {
    const ir = irs.get(sc.story);
    if (ir) found.push(...collect(ir.root, key, sc.files));
  }
  // The same element appears once per variant; list it once.
  const seen = new Set<string>();
  return found.filter((u) => {
    const k = `${u.owner}|${u.path}|${u.text ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function name(args: string[]): Promise<number> {
  const config = requireConfig() as { storybook?: { build?: string; out?: string }; vocabulary?: string[] };
  const sb = config.storybook ?? {};
  const build = () =>
    execSync(sb.build ?? "pnpm build-storybook", { stdio: "ignore", env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" } });
  if (!args.includes("--no-build")) build();
  const out = resolve(sb.out ?? "storybook-static");
  const unnamed = await find(out);
  if (!unnamed.length) {
    console.log("every element of every registered component and page has a name");
    return 0;
  }
  console.log(`${unnamed.length} unnamed element(s):`);
  for (const u of unnamed) console.log(`  ${u.owner}: ${u.path}${u.text ? ` ("${u.text}")` : ""}`);
  if (args.includes("--check")) return 1;

  const files = [...new Set(unnamed.flatMap((u) => u.files))];
  const vocabulary = [...VOCABULARY, ...(config.vocabulary ?? [])];
  const prompt = `Give these unnamed elements a semantic layer name by adding a data-cdf attribute to the JSX element.

Elements (owner component or page › layer path; the last segment is the element's HTML tag; quoted text is its content):
${unnamed.map((u) => `- ${u.owner} (${u.files.filter((f) => /\.[jt]sx?$/.test(f)).join(", ")}): ${u.path}${u.text ? ` — text "${u.text}"` : ""}`).join("\n")}

Rules:
- Add exactly one attribute per element: data-cdf="<name>". Names are lowercase kebab-case, short, describe the element's role, and are unique among its siblings.
- Prefer these words when they fit: ${vocabulary.join(", ")}. Siblings of the same kind get distinct names (e.g. "subtotal-row", "shipping-row", "total-row").
- Change nothing else: no refactors, no formatting changes, no new classes, no logic changes.
- If an element is produced by another component (not written as JSX in these files), skip it.
- Edit only: ${files.join(", ")}. Do not run git.

When done, reply with ONLY: {"named": <number of attributes added>}
`;
  console.error("asking Claude Code to name them…");
  const cc = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read",
      "Glob",
      "Grep",
      ...files.map((f) => `Edit(${f})`),
      "--output-format",
      "json",
    ],
    {
      encoding: "utf8",
      timeout: 900_000,
    },
  );
  if (cc.error) throw new Error(`could not run Claude Code: ${cc.error.message}`);
  build();
  const left = await find(out);
  console.log(`named ${unnamed.length - left.length} of ${unnamed.length}; review the data-cdf attributes in your diff and commit them`);
  for (const u of left) console.log(`  still unnamed: ${u.owner}: ${u.path}`);
  return left.length ? 1 : 0;
}
