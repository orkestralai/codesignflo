// codesignflo stories [--json] [--no-build]: the app's components that have no story yet, so the developer's
// coding agent can cover them. Each component with stories becomes a component in Live (Live › Components),
// which the designer can then link to their design system.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { requireConfig } from "../project.js";
import { type Coverage, storyCoverage } from "../stories.js";

type StoryConfig = { storybook?: { build?: string; out?: string }; components?: string[] };

/** The coverage of the built Storybook (building it first when it isn't built yet, unless told not to). */
export function coverage(args: string[] = []): Coverage {
  const config = requireConfig() as ReturnType<typeof requireConfig> & StoryConfig;
  const out = resolve(config.storybook?.out ?? "storybook-static");
  const index = join(out, "index.json");
  if (!existsSync(index)) {
    if (args.includes("--no-build")) throw new Error(`no Storybook build in ${out}: build it first, or run without --no-build`);
    console.error(`building Storybook (${config.storybook?.build ?? "pnpm build-storybook"})…`);
    execSync(config.storybook?.build ?? "pnpm build-storybook", {
      stdio: "ignore",
      env: { ...process.env, STORYBOOK_DISABLE_TELEMETRY: "1" },
    });
  }
  return storyCoverage(process.cwd(), index, config.components);
}

/** One line for sync's output when components have no story (nothing when all do). */
export function coverageLine(c: Coverage): string | null {
  if (!c.missing.length) return null;
  return `${c.missing.length} of ${c.files} component file(s) have no story, so they aren't components in Live yet — run: codesignflo stories (or ask your coding agent to cover them)`;
}

export function stories(args: string[]): number {
  const c = coverage(args);
  if (args.includes("--json")) {
    console.log(JSON.stringify(c, null, 2));
    return 0;
  }
  if (!c.missing.length) {
    console.log(`All ${c.files} component file(s) have stories: each one is a component in Live.`);
    return 0;
  }
  console.log(`${c.covered} of ${c.files} component file(s) have stories. Without one, a component isn't in Live › Components:`);
  // The building blocks the pages use first, most used first: only a component with a story of its own can
  // be placed on a page (and drawn there with the designer's). Counted through imports, so a dialog that's
  // closed counts too: screens, panels and dialogs are listed apart, their stories are optional.
  const line = (m: (typeof c.missing)[number]) =>
    `  ${m.file}: ${m.components.join(", ")} (${m.pages} page${m.pages === 1 ? "" : "s"}${m.lines > 400 ? `, ${m.lines} lines` : ""})`;
  const blocks = c.missing.filter((m) => m.pages && m.kind === "block");
  const panels = c.missing.filter((m) => m.pages && m.kind === "panel");
  if (blocks.length) {
    console.log(`\nBuilding blocks your pages use (cover these first; "N pages" = page stories that import it):`);
    for (const m of blocks) console.log(line(m));
  }
  if (panels.length) {
    console.log(`\nScreens, panels and dialogs your pages use (a story is optional: they're rarely in a design system):`);
    for (const m of panels) console.log(line(m));
  }
  const rest = c.missing.filter((m) => !m.pages);
  const byFolder = new Map<string, typeof rest>();
  for (const m of rest) {
    const folder = m.file.split("/").slice(0, -1).join("/");
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), m]);
  }
  if (rest.length) console.log("\nOn no page story (yet):");
  const shared = (f: string) => (/(^|\/)(ui|primitives|common|shared|base)(\/|$)/.test(f) ? 0 : 1);
  for (const [folder, files] of [...byFolder].sort((a, b) => shared(a[0]) - shared(b[0]) || b[1].length - a[1].length)) {
    console.log(`\n${folder}/ (${files.length})`);
    for (const f of files)
      console.log(
        `  ${f.file.slice(folder.length + 1)}: ${f.components.join(", ")}${f.kind === "panel" ? " (screen, panel or dialog)" : ""}`,
      );
  }
  console.log(
    `\nAsk your coding agent to cover them (CoDesignFlo's MCP has a prompt for it, "cover_components"): a stories file next to each component, titled "Components/<Name>", with the variants it really has, and layout "padded" when the project's preview makes every story fullscreen. Then sync.`,
  );
  return 0;
}
