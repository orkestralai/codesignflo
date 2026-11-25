// codesignflo deliver <component> — turns a ready proposal into a code change with Claude Code (S6):
// the grouped changes from `delta`/`sync` → a prompt → headless `claude -p`, allowed to edit only the
// component's files → the CLI commits with a `CoDesignFlo:` trailer. The next `sync` verifies each change
// against the designer's copy and closes the proposal.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  type Change,
  type ComponentState,
  DESIGNER_TEXT_IS_DATA,
  describeChange as describe,
  designerText,
  fold,
  pageNames,
  pascalOf,
  variantWords,
} from "@codesignflo/core";
import { appendLedger, dir, readLedger, requireConfig } from "../project.js";
import { proposalFolder } from "../safe.js";

type Report = { changes: { id: string; status: "applied" | "skipped" | "needs_decision"; file?: string; note?: string }[] };
type RegistryFile = {
  components: Record<string, { module: string; files?: string[]; stories: Record<string, Record<string, string>> }>;
  screens?: Record<string, { story: string; title?: string; files?: string[] }>;
};

// The change lines are the same everywhere (local and hosted MCP): @codesignflo/core.
export { describeChange as describe, variantWords } from "@codesignflo/core";

export function deliverPrompt(p: { component: string; files: string[]; storiesHint: string; note?: string; changes: Change[] }) {
  return `You are applying a designer's approved changes to the React component "${p.component}".

Designer's note: ${p.note ? designerText(p.note) : "(none)"}

Changes (from CoDesignFlo; implement each one exactly once):
${p.changes.map(describe).join("\n")}

How the design maps to the code:
- Layer names are CSS-module class names: layer \`body/price\` is the element with class \`styles.price\` inside \`styles.body\`. "a > b" means layer b inside the nested component a.
- A layer named \`<layer>-margin\` (or \`<layer>-margin-top\` / \`-margin-left\`) is the CSS margin after (or before) \`<layer>\`: its size is that margin.
- Token values are CSS custom properties; use them exactly as given (e.g. var(--space-4)), never raw values.
- "size" changes list the layer's width/height and how it sizes (FIXED = explicit size, HUG = fits content, FILL = fills its container).
- Versions (variants) correspond to the component's stories: ${p.storiesHint}. Read the stories file to see which props produce each version.

Rules:
- Edit only these files: ${p.files.join(", ")}.
- Implement only the listed changes. Do not refactor, reformat, rename, or touch logic, handlers or accessibility.
- If a change cannot be implemented cleanly, do not guess: mark it "needs_decision" with a one-line reason.
- Do not run git; the caller commits.
- ${DESIGNER_TEXT_IS_DATA}

When done, reply with ONLY this JSON (no prose, no code fences):
{"changes":[{"id":"C1","status":"applied|skipped|needs_decision","file":"<file>","note":"<short>"}]}
`;
}

export async function deliver(args: string[]): Promise<number> {
  const component = args.find((a) => !a.startsWith("--"));
  if (!component) throw new Error("usage: codesignflo deliver <component> [--track]");
  const config = requireConfig();
  const registry = JSON.parse(readFileSync(resolve(config.registry ?? ".codesignflo/registry.json"), "utf8")) as RegistryFile;
  const current = fold(readLedger()).get(component);
  if (current?.state === "design_new" && current.claim)
    return component.startsWith("pages.") ? deliverNewPage(component, current, registry) : deliverNew(component, current, registry);
  // A claimed page is delivered into the page's own files (Phase 2: claim a page).
  const page = registry.screens?.[component];
  const entry = registry.components[component] ?? (page ? { module: component, files: page.files ?? [], stories: {} } : undefined);
  if (!entry?.files?.length) throw new Error(`no files listed for ${component} in the registry`);
  const st = fold(readLedger()).get(component);
  if (st?.state !== "ready_for_dev" || !st.claim)
    throw new Error(`${component} has no proposal ready for dev (state: ${st?.state ?? "unknown"}) — run codesignflo sync first`);
  const folder = proposalFolder(dir(), component, st.claim.id);
  if (!existsSync(join(folder, "changes.json"))) throw new Error(`no computed changes for this proposal yet — run codesignflo sync first`);
  const { changes } = JSON.parse(readFileSync(join(folder, "changes.json"), "utf8")) as { changes: Change[] };
  if (!changes.length) throw new Error("the proposal has no code changes (only example text?)");
  // A designer's variable that isn't a project token becomes one: the tokens file may change too.
  const files = changes.some((c) => c.foreign?.length) ? [...entry.files, config.tokens ?? "tokens/tokens.json"] : entry.files;
  if (args.includes("--track")) return track(component, st.claim, files, folder, changes);

  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...entry.files], { encoding: "utf8" }).trim();
  if (dirty) throw new Error(`these files have uncommitted changes; commit or stash them first:\n${dirty}`);

  const storiesHint = Object.entries(entry.stories)
    .map(
      ([story, props]) =>
        `${variantWords(
          Object.entries(props)
            .map(([k, v]) => `${k}=${v}`)
            .join(","),
        )} = story "${story}"`,
    )
    .join("; ");
  const prompt =
    deliverPrompt({ component, files: files, storiesHint, ...(st.claim.note ? { note: st.claim.note } : {}), changes }) +
    (page
      ? `\nThis is a page (story ${page.story}). Layers inside "a > b" are inside a component used on the page: change the page's use of it (props, wrapper styles) only; if the change needs the component itself to change, mark it "needs_decision" ("this changes <component> everywhere — claim the component instead?").\n`
      : "");
  console.error(`asking Claude Code to apply ${changes.length} change(s) to ${files.join(", ")}…`);
  const t0 = Date.now();
  // What was already modified before (e.g. ledger files written by sync) doesn't count as Claude Code's work.
  const { report, touched } = runClaude(
    prompt,
    files.map((f) => `Edit(${f})`),
  );
  // Kept with the proposal: sync uses it to tell the designer what was applied and what needs them.
  writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Claude Code finished in ${Math.round((Date.now() - t0) / 1000)} s:`);
  for (const r of report.changes) console.log(`  ${r.id}: ${r.status}${r.note ? ` — ${r.note}` : ""}`);

  // Only the component's files may change; anything else is a hard stop.
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  const allowed = new Set(files.map((f) => `${prefix}${f}`));
  const outside = touched.filter((f) => !allowed.has(f));
  if (outside.length)
    throw new Error(`Claude Code changed files outside ${component}: ${outside.join(", ")} — nothing committed, review the working tree`);
  const applied = report.changes.filter((r) => r.status === "applied").map((r) => r.id);
  if (!applied.length) {
    console.log("nothing applied; nothing committed");
    return 1;
  }
  const trailer = `CoDesignFlo: ${component} claim=${st.claim.id} items=${applied.join(",")}`;
  execFileSync("git", ["add", "--", ...files]);
  execFileSync("git", [
    "commit",
    "-q",
    "-m",
    `Apply design proposal to ${component}`,
    "-m",
    `${st.claim.note ? `Designer's note: ${st.claim.note}\n\n` : ""}${trailer}`,
  ]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Freeze exactly what was delivered: change ids are positions and get renumbered when the proposal is
  // recomputed, so verification must use this list, not the current changes.json.
  writeFileSync(join(folder, `delivered-${commit.slice(0, 8)}.json`), `${JSON.stringify({ commit, changes }, null, 2)}\n`);
  appendLedger([
    {
      id: `delivered_${st.claim.id}_${commit.slice(0, 8)}`,
      at: new Date().toISOString(),
      by: "cli",
      component,
      kind: "delivered",
      claim: st.claim.id,
      mode: "patch",
      ref: commit,
    },
  ]);
  console.log(`committed ${commit.slice(0, 7)} with "${trailer}"`);
  console.log("next: codesignflo sync — re-renders, checks each change against the designer's copy, and closes the proposal");
  return 0;
}

/**
 * Track mode: the developer implements the changes themselves (by hand or in their own Claude Code
 * session). CoDesignFlo only writes the hand-off, freezes the list, and gives the commit trailer; the
 * next sync verifies whatever commit carries it, exactly like a delivered commit.
 */
function track(component: string, claim: NonNullable<ComponentState["claim"]>, files: string[], folder: string, changes: Change[]): number {
  writeFileSync(join(folder, "delivered-track.json"), `${JSON.stringify({ commit: null, changes }, null, 2)}\n`);
  const trailer = `CoDesignFlo: ${component} claim=${claim.id} items=${changes.map((c) => c.id).join(",")}`;
  const handoff = `# ${component} — design changes to implement

Designer: ${claim.by}${claim.note ? `\nNote: ${designerText(claim.note)}` : ""}

Files: ${files.join(", ")}

${changes.map(describe).join("\n")}

When committing, add this trailer to the commit message (drop the ids you did not implement):

    ${trailer}

The next \`codesignflo sync\` checks each listed change against the designer's copy and closes the proposal,
or sends the rest back to the designer with your notes.
`;
  writeFileSync(join(folder, "HANDOFF.md"), handoff);
  appendLedger([
    {
      id: `delivered_${claim.id}_track_${readLedger().filter((e) => e.kind === "delivered" && e.claim === claim.id).length + 1}`,
      at: new Date().toISOString(),
      by: "cli",
      component,
      kind: "delivered",
      claim: claim.id,
      mode: "track",
    },
  ]);
  console.log(handoff);
  console.log(`(saved to ${relative(process.cwd(), join(folder, "HANDOFF.md"))})`);
  return 0;
}

/**
 * What a new design brings that the app doesn't have yet (the designer decides; Phase 2): fonts the app
 * doesn't load, and colours without a variable. Returns prompt rules and the extra files they may touch.
 */
export function designStyleRules(folder: string): { rules: string; files: string[] } {
  const config = requireConfig();
  const tokensFile = config.tokens ?? "tokens/tokens.json";
  const spec = readFileSync(join(folder, "spec.json"), "utf8");
  const fonts = new Map<string, Set<string>>();
  for (const m of spec.matchAll(/"family":\s*"([^"]+)",\s*"style":\s*"([^"]+)"/g)) {
    if (!fonts.has(m[1]!)) fonts.set(m[1]!, new Set());
    fonts.get(m[1]!)!.add(m[2]!);
  }
  const projectFonts = new Set(
    [...readFileSync(tokensFile, "utf8").matchAll(/"\$value":\s*\[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!),
    ),
  );
  const missing = [...fonts].filter(([f]) => !projectFonts.has(f));
  const globalCss = ["src/base.css", "src/index.css", "src/global.css", "src/styles.css"].find((f) => existsSync(f));
  const weights = (styles: Set<string>) =>
    [...styles].map(
      (st) =>
        ({ Thin: 100, Light: 300, Regular: 400, Medium: 500, "Semi Bold": 600, SemiBold: 600, Bold: 700, Black: 900 })[
          st.replace(/ Italic$/, "")
        ] ?? 400,
    );
  const fontRule = missing.length
    ? `- Fonts: the design uses ${missing.map(([f, st]) => `${f} (${[...st].join(", ")})`).join("; ")}, which the app doesn't load. The designer chose ${missing.length > 1 ? "them" : "it"}: load ${missing.length > 1 ? "them" : "it"} in ${globalCss ?? "the app's global stylesheet"} with a Google Fonts @import (e.g. @import url("https://fonts.googleapis.com/css2?family=${missing[0]![0].replace(/ /g, "+")}:wght@${[...new Set(weights(missing[0]![1]))].sort().join(";")}&display=swap");), add a font-family token to ${tokensFile} and use it for this design only. Don't change the font of anything else.\n`
    : "";
  return {
    rules: `${fontRule}- Colours without a Figma variable: use the project token with the same value; if there is none, add a token to ${tokensFile} named after its use (e.g. color.alert.surface) and use it — no raw hex in the styles.\n`,
    files: [tokensFile, ...(missing.length && globalCss ? [globalCss] : [])],
  };
}

/** Runs headless Claude Code limited to `files`/`folder`; returns its report and the files it touched. */
function runClaude(prompt: string, allowed: string[]): { report: Report; touched: string[] } {
  const status = () =>
    new Set(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).split("\n").filter(Boolean));
  const before = status();
  const cc = spawnSync(
    "claude",
    ["-p", prompt, "--permission-mode", "acceptEdits", "--allowedTools", "Read", "Glob", "Grep", ...allowed, "--output-format", "json"],
    { encoding: "utf8", timeout: 900_000 },
  );
  if (cc.error) throw new Error(`could not run Claude Code: ${cc.error.message}`);
  let report: Report;
  try {
    const result = (JSON.parse(cc.stdout) as { result: string }).result;
    report = JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Report;
  } catch {
    throw new Error(`Claude Code did not return a report:\n${(cc.stdout || cc.stderr).slice(0, 2000)}`);
  }
  return { report, touched: [...status()].filter((l) => !before.has(l)).map((l) => l.slice(3)) };
}

/**
 * A designer's new component: Claude Code builds it (component, styles, stories) in a new folder next to
 * the existing components, following their conventions, from the designer's frame (spec.json + design.png
 * written by sync). The next sync registers it from Storybook and closes the proposal.
 */
async function deliverNew(component: string, st: ComponentState, registry: RegistryFile): Promise<number> {
  const claim = st.claim!;
  const folder = proposalFolder(dir(), component, claim.id);
  if (!existsSync(join(folder, "spec.json"))) throw new Error("no spec for this new design yet — run codesignflo sync first");
  // Where components live: the folder that holds most registered components' folders.
  const parents = Object.values(registry.components).map((c) => dirname(dirname(c.files?.[0] ?? "")));
  const parent = [...new Set(parents)].sort((a, b) => parents.filter((p) => p === b).length - parents.filter((p) => p === a).length)[0];
  if (!parent || parent === ".") throw new Error("could not tell where components live (no registered components with files)");
  const name = pascalOf(component.split(".").pop() ?? component);
  const target = join(parent, name);
  if (existsSync(target)) throw new Error(`${target} already exists — rename the design or remove the folder`);
  // An existing component to copy conventions from: the one with the most files (component + styles + …).
  const example = Object.entries(registry.components).sort((a, b) => (b[1].files?.length ?? 0) - (a[1].files?.length ?? 0))[0]!;
  const exampleFolder = dirname(example[1].files![0]!);
  const rel = (f: string) => relative(process.cwd(), f);
  const style = designStyleRules(folder);
  const prompt = `Build a new React component "${name}" from a designer's design.

Designer's note: ${claim.note ? designerText(claim.note) : "(none)"}

The design:
- ${rel(join(folder, "design.png"))} — a picture of it (read it).
- ${rel(join(folder, "spec.json"))} — its exact layers: sizes, auto layout (direction, gap, padding, alignment), colours, borders, radii, text styles. Token values appear as var(collection/name); use the matching CSS custom properties from the project's tokens, never raw values when a token exists. If it has variants (a component set), each variant's properties become props.

Follow the conventions of the existing component in ${exampleFolder}/ exactly (read every file there, including its stories file): same file layout, styling approach, naming, exports and story format.

Create, in ${target}/ only:
- the component and its styles;
- a stories file whose title is exactly "${name}", with one story per variant (and a default story), using realistic example data.

Rules:
- Name every element that maps to a layer with a data-cdf attribute in lowercase kebab-case matching the layer names in the spec where they make sense (e.g. data-cdf="title").
${style.rules}- Do not edit any other file; do not add the component to pages (the developer decides where it is used).
- Do not run git or install packages.

When done, reply with ONLY this JSON (no prose, no code fences):
{"changes":[{"id":"new","status":"applied|needs_decision","file":"<main file>","note":"<short: what you built, or what is unclear>"}]}
`;
  console.error(`asking Claude Code to build ${name} in ${target}…`);
  const t0 = Date.now();
  const { report, touched } = runClaude(
    prompt,
    [`${target}/**`, ...style.files].flatMap((f) => [`Edit(${f})`, `Write(${f})`]),
  );
  writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Claude Code finished in ${Math.round((Date.now() - t0) / 1000)} s:`);
  for (const r of report.changes) console.log(`  ${r.status}${r.note ? ` — ${r.note}` : ""}`);
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  const outside = touched.filter(
    (f) => !f.startsWith(`${prefix}${target}/`) && !style.files.some((x) => f === `${prefix}${x}`) && !/(^|\/)src\/tokens\.css$/.test(f),
  );
  if (outside.length)
    throw new Error(`Claude Code changed files outside ${target}: ${outside.join(", ")} — nothing committed, review the working tree`);
  if (!touched.length || !report.changes.some((r) => r.status === "applied")) {
    console.log("nothing built; nothing committed");
    return 1;
  }
  const trailer = `CoDesignFlo: ${component} claim=${claim.id} items=new`;
  execFileSync("git", ["add", "--", ...touched.map((f) => f.slice(prefix.length))]);
  execFileSync("git", [
    "commit",
    "-q",
    "-m",
    `Add ${name} from a new design`,
    "-m",
    `${claim.note ? `Designer's note: ${claim.note}\n\n` : ""}${trailer}`,
  ]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  appendLedger([
    {
      id: `delivered_${claim.id}_${commit.slice(0, 8)}`,
      at: new Date().toISOString(),
      by: "cli",
      component,
      kind: "delivered",
      claim: claim.id,
      mode: "patch",
      ref: commit,
    },
  ]);
  console.log(`committed ${commit.slice(0, 7)} with "${trailer}"`);
  console.log("next: codesignflo sync — registers it from Storybook, builds it in Live and closes the proposal");
  return 0;
}

/**
 * A designer's new page (M6): Claude Code builds it as a page of the app — a page file next to the existing
 * pages reusing the registered components, a Storybook page story (so CoDesignFlo renders it in Live →
 * Screens from Live instances) and a route. The next sync closes the proposal when the story appears.
 */
async function deliverNewPage(component: string, st: ComponentState, registry: RegistryFile): Promise<number> {
  const claim = st.claim!;
  const folder = proposalFolder(dir(), component, claim.id);
  if (!existsSync(join(folder, "spec.json"))) throw new Error("no spec for this new design yet — run codesignflo sync first");
  const screens = Object.values(registry.screens ?? {});
  const examplePage = screens.find((x) => x.files?.length)?.files ?? [];
  const pagesDir = examplePage[0] ? dirname(examplePage[0]) : "src/pages";
  const storiesFile = existsSync(pagesDir) ? readdirSync(pagesDir).find((f) => /\.stories\.[jt]sx?$/.test(f)) : undefined;
  if (!storiesFile) throw new Error(`no page stories file in ${pagesDir} (CoDesignFlo renders pages from a Storybook page story)`);
  const stories = join(pagesDir, storiesFile);
  const app = ["src/App.tsx", "src/App.jsx", "src/app.tsx"].find((f) => existsSync(f));
  const base = component.replace(/^pages\./, "").replace(/-page$/, "");
  const names = pageNames(base);
  const target = join(pagesDir, names.component);
  if (existsSync(`${target}.tsx`) || existsSync(`${target}.jsx`)) throw new Error(`${target} already exists — rename the design`);
  const rel = (f: string) => relative(process.cwd(), f);
  // Pages render at a fixed width in their stories; a new page renders at the width it was designed at.
  const designWidth = Math.round(Number((JSON.parse(readFileSync(join(folder, "spec.json"), "utf8")) as { width?: number }).width ?? 0));
  const components = Object.values(registry.components)
    .map((c) => `- ${c.module}: ${(c.files ?? []).filter((f) => /\.[jt]sx?$/.test(f)).join(", ")}`)
    .join("\n");
  const pageStyle = designStyleRules(folder);
  const prompt = `Build a new page "${names.component}" of this React app from a designer's full-screen design.

Designer's note: ${claim.note ? designerText(claim.note) : "(none)"}

The design:
- ${rel(join(folder, "design.png"))} — a picture of it (read it).
- ${rel(join(folder, "spec.json"))} — its exact layers: sizes, auto layout, colours, text. INSTANCE layers are existing components (their mainComponent names the component and its variant): reuse those React components with matching props, don't rebuild them.

Existing components (reuse them where the design uses them):
${components}

Follow the conventions of the existing pages (${examplePage.join(", ")}) exactly: file layout, styling approach, naming, data and component usage.

Create / change exactly:
1. ${target}.tsx (+ its styles next to it, named like the existing pages' styles): the page component \`${names.component}\`. Example data like the existing pages use.
2. ${stories}: add \`export const ${names.story}\` rendering \`<${names.component} />\`, like the other page stories (keep the file's decorators and parameters).${designWidth ? ` The design is ${designWidth}px wide: render this story at that width without nesting a second container — if the file's decorator has a fixed width, make it read a story parameter (\`parameters.width\`, defaulting to the current width) and set \`parameters: { width: ${designWidth} }\` on the new story.` : ""}
${app ? `3. ${app}: add a route for it (\`#/${base}\`), like the existing routes.` : ""}

Rules:
- Name every element that maps to a layer with a data-cdf attribute (lowercase kebab-case, the spec's layer names where they make sense).
- Colours, spacing, radii, font sizes: use the project's tokens (CSS custom properties) when one has the same value; a Figma variable from the design that isn't a project token yet is the designer's decision — add it to the tokens file and use it.
${pageStyle.rules}- Do not change existing components or other pages. Do not run git or install packages.

When done, reply with ONLY this JSON (no prose, no code fences):
{"changes":[{"id":"new","status":"applied|needs_decision","file":"<page file>","note":"<short: what you built, or what is unclear>"}]}
`;
  console.error(`asking Claude Code to build the page ${names.component} (${target}.tsx, story ${names.story})…`);
  const t0 = Date.now();
  const tokens = requireConfig().tokens ?? "tokens/tokens.json";
  const allowed = [`${target}.*`, stories, ...(app ? [app] : []), tokens, ...pageStyle.files];
  const { report, touched } = runClaude(
    prompt,
    allowed.flatMap((f) => [`Edit(${f})`, `Write(${f})`]),
  );
  writeFileSync(join(folder, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Claude Code finished in ${Math.round((Date.now() - t0) / 1000)} s:`);
  for (const r of report.changes) console.log(`  ${r.status}${r.note ? ` — ${r.note}` : ""}`);
  const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  const ok = (f: string) =>
    f.startsWith(`${prefix}${target}.`) ||
    [stories, app, tokens, ...pageStyle.files].some((x) => x && f === `${prefix}${x}`) ||
    /(^|\/)src\/tokens\.css$/.test(f);
  const outside = touched.filter((f) => !ok(f));
  if (outside.length)
    throw new Error(`Claude Code changed files outside the new page: ${outside.join(", ")} — nothing committed, review the working tree`);
  if (!touched.length || !report.changes.some((r) => r.status === "applied")) {
    console.log("nothing built; nothing committed");
    return 1;
  }
  const trailer = `CoDesignFlo: ${component} claim=${claim.id} items=new`;
  execFileSync("git", ["add", "--", ...touched.map((f) => f.slice(prefix.length))]);
  execFileSync("git", [
    "commit",
    "-q",
    "-m",
    `Add the ${names.component} page from a new design`,
    "-m",
    `${claim.note ? `Designer's note: ${claim.note}\n\n` : ""}${trailer}`,
  ]);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  appendLedger([
    {
      id: `delivered_${claim.id}_${commit.slice(0, 8)}`,
      at: new Date().toISOString(),
      by: "cli",
      component,
      kind: "delivered",
      claim: claim.id,
      mode: "patch",
      ref: commit,
    },
  ]);
  console.log(`committed ${commit.slice(0, 7)} with "${trailer}"`);
  console.log("next: codesignflo sync — renders the page story, builds it in Live → Pages and closes the proposal");
  return 0;
}
