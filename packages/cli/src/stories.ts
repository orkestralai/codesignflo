// Which of the app's components have no story yet. Live only knows the components Storybook shows: a project
// whose Storybook has only page stories gets an empty Live › Components and nothing to link to the designer's
// design system. This lists the components to cover, for the developer and their coding agent (who writes
// the stories: only something that reads the code can choose realistic props and data).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** A component file without a story: how many page stories render it (through their imports), and how many files import it. */
export type Uncovered = {
  file: string;
  components: string[];
  lines: number;
  /** Page stories that import it (directly or not): it may be drawn there, or be a dialog that's closed. */
  pages?: number;
  importedBy?: number;
  /** "block": a building block for the design system; "panel": a screen, panel or dialog (a story is optional). */
  kind: "block" | "panel";
};

/** Screens, panels and dialogs by name, or anything long: not the design system's building blocks. */
export const panelLike = (components: string[], lines: number) =>
  lines > 400 ||
  components.every((c) => /(Modal|Dialog|Panel|Shell|Workspace|Client|Page|Screen|Settings|Wizard|Designer|Explorer|Picker)$/.test(c));
export type Coverage = { files: number; covered: number; missing: Uncovered[] };

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  ".storybook",
  ".turbo",
]);
const SOURCE = /\.(tsx|jsx)$/;
const NOT_COMPONENT_FILE = /\.(stories|test|spec)\.[jt]sx?$|(^|\/)(page|layout|loading|error|not-found|route|template|default)\.[jt]sx$/;

/** Folders that hold components: `components` from the config, else every folder named "components". */
export function componentRoots(projectDir: string, configured?: string[]): string[] {
  if (configured?.length) return configured.map((r) => join(projectDir, r)).filter((r) => existsSync(r));
  const roots: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (name === "components") roots.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(projectDir, 0);
  return roots;
}

/**
 * The React components a file exports: PascalCase names exported as functions, consts (arrow functions,
 * forwardRef, memo) or the default export, in a file that renders JSX. Hooks, types and helpers are left out.
 */
export function exportedComponents(source: string): string[] {
  if (!/<[A-Za-z][\w.]*[\s/>]|React\.createElement/.test(source)) return [];
  const names = new Set<string>();
  const pascal = /^[A-Z][A-Za-z0-9]*$/;
  for (const m of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) names.add(m[1]!);
  for (const m of source.matchAll(
    /export\s+const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:React\.)?(?:forwardRef|memo|\(|async\s*\(|function|[a-zA-Z_]+\s*=>)/g,
  ))
    names.add(m[1]!);
  for (const m of source.matchAll(/export\s+default\s+(?:React\.)?(?:memo|forwardRef)?\(?\s*([A-Za-z0-9_]+)\s*\)?\s*;?\s*$/gm))
    names.add(m[1]!);
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g))
    for (const part of m[1]!.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name && name !== "default") names.add(name);
    }
  return [...names].filter((n) => pascal.test(n) && !/^(Props|Type|Context)$/.test(n) && !n.endsWith("Props"));
}

type IndexEntry = { type: string; importPath: string; componentPath?: string; title: string };

/**
 * Files Storybook covers: each story group's component (its `component`, as `componentPath`) and the files next to
 * a stories file named like it (Button.stories.tsx covers Button.tsx). Page stories don't cover the components a
 * page uses: those need stories of their own to be components in Live.
 */
export function coveredFiles(projectDir: string, index: { entries: Record<string, IndexEntry> }): Set<string> {
  const norm = (p: string) =>
    relative(projectDir, join(projectDir, p.replace(/^\.\//, "")))
      .split(sep)
      .join("/");
  const out = new Set<string>();
  for (const e of Object.values(index.entries)) {
    if (/^(pages|screens)(\/|$)/i.test(e.title)) continue;
    if (e.componentPath) {
      out.add(norm(e.componentPath));
      // A folder (./components/ui/Button) or its index: the files the index re-exports are the component.
      const target = resolveImport(projectDir, join(projectDir, "x"), e.componentPath, []);
      if (target) {
        out.add(norm(relative(projectDir, target)));
        if (/(^|[\\/])index\.[jt]sx?$/.test(target))
          for (const m of readFileSync(target, "utf8").matchAll(IMPORT)) {
            const r = resolveImport(projectDir, target, (m[1] ?? m[2])!, []);
            if (r) out.add(norm(relative(projectDir, r)));
          }
      }
    }
    const sibling = e.importPath.replace(/\.stories\.([jt]sx?)$/, ".$1");
    if (sibling !== e.importPath) for (const ext of ["tsx", "jsx", "ts", "js"]) out.add(norm(sibling.replace(/\.[jt]sx?$/, `.${ext}`)));
  }
  return out;
}

/**
 * The component folders this Storybook draws from: those holding a file some story renders (its component,
 * pages included). A repo can hold other apps and vendored code with "components" folders of their own, which
 * this Storybook never shows (orkestral: an admin app, a blog, a vendored tool).
 */
export function usedRoots(projectDir: string, index: { entries: Record<string, IndexEntry> }, candidates: string[]): string[] {
  const used = Object.values(index.entries)
    .flatMap((e) => [e.componentPath, e.importPath])
    .filter((p): p is string => !!p)
    .map((p) => join(projectDir, p.replace(/^\.\//, "")));
  const inUse = candidates.filter((r) => used.some((f) => f.startsWith(r + sep)));
  return inUse.length ? inUse : candidates;
}

// ---- which pages use what ------------------------------------------------------------------------

const IMPORT = /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXTS = [".tsx", ".ts", ".jsx", ".js"];

/** JSON with comments and trailing commas (tsconfig) → JSON; strings are kept as they are (an "include" glob). */
export function jsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") while (i < text.length && text[i] !== "\n") i++;
    else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** tsconfig's path aliases ("@/*" → "./*"), relative to the project. */
function aliases(projectDir: string): [string, string][] {
  try {
    const raw = jsonc(readFileSync(join(projectDir, "tsconfig.json"), "utf8"));
    const c = JSON.parse(raw) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const base = c.compilerOptions?.baseUrl ?? ".";
    return Object.entries(c.compilerOptions?.paths ?? {}).flatMap(([from, to]) =>
      to[0] ? [[from.replace(/\*$/, ""), join(base, to[0].replace(/\*$/, ""))] as [string, string]] : [],
    );
  } catch {
    return [];
  }
}

/** The project's files an import names (relative or through an alias), or null for packages. */
function resolveImport(projectDir: string, from: string, spec: string, alias: [string, string][]): string | null {
  let base: string | null = null;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else
    for (const [a, to] of alias)
      if (spec.startsWith(a)) {
        base = resolve(projectDir, to, spec.slice(a.length));
        break;
      }
  if (!base) return null;
  for (const cand of [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => join(base!, `index${e}`))])
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return null;
}

/**
 * Per file, how many page stories reach it through their imports, and how many files import it: the
 * components to cover first are the ones the app's pages draw most (a page story can only place a component
 * that has a story of its own).
 */
export function pageUse(
  projectDir: string,
  index: { entries: Record<string, IndexEntry> },
): { pages: Map<string, number>; importedBy: Map<string, number> } {
  const alias = aliases(projectDir);
  const importsOf = new Map<string, string[]>();
  const imports = (file: string): string[] => {
    let out = importsOf.get(file);
    if (out) return out;
    out = [];
    importsOf.set(file, out);
    let src = "";
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return out;
    }
    for (const m of src.matchAll(IMPORT)) {
      const r = resolveImport(projectDir, file, (m[1] ?? m[2])!, alias);
      if (r && !r.includes(`${sep}node_modules${sep}`) && !out.includes(r)) out.push(r);
    }
    return out;
  };
  const rel = (f: string) => relative(projectDir, f).split(sep).join("/");
  const pages = new Map<string, number>();
  const pageStories = [
    ...new Set(
      Object.values(index.entries)
        .filter((e) => /^(pages|screens)(\/|$)/i.test(e.title))
        .map((e) => e.importPath),
    ),
  ];
  for (const story of pageStories) {
    const seen = new Set<string>();
    const stack = [resolve(projectDir, story.replace(/^\.\//, ""))];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...imports(f));
    }
    for (const f of seen) pages.set(rel(f), (pages.get(rel(f)) ?? 0) + 1);
  }
  const importedBy = new Map<string, number>();
  for (const [, list] of importsOf) for (const f of list) importedBy.set(rel(f), (importedBy.get(rel(f)) ?? 0) + 1);
  return { pages, importedBy };
}

/** The app's components with no story, against a built Storybook's index.json. */
export function storyCoverage(projectDir: string, indexJson: string, configuredRoots?: string[]): Coverage {
  const index = JSON.parse(readFileSync(indexJson, "utf8")) as { entries: Record<string, IndexEntry> };
  const covered = coveredFiles(projectDir, index);
  const use = pageUse(projectDir, index);
  const missing: Uncovered[] = [];
  let files = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(projectDir, p).split(sep).join("/");
      if (!SOURCE.test(name) || NOT_COMPONENT_FILE.test(rel)) continue;
      const source = readFileSync(p, "utf8");
      const components = exportedComponents(source);
      if (!components.length) continue;
      files++;
      const lines = source.split("\n").length;
      if (!covered.has(rel))
        missing.push({
          file: rel,
          components,
          lines,
          kind: panelLike(components, lines) ? "panel" : "block",
          ...(use.pages.get(rel) ? { pages: use.pages.get(rel) } : {}),
          ...(use.importedBy.get(rel) ? { importedBy: use.importedBy.get(rel) } : {}),
        });
    }
  };
  const roots = componentRoots(projectDir, configuredRoots);
  for (const root of configuredRoots?.length ? roots : usedRoots(projectDir, index, roots)) walk(root);
  // The ones the pages draw most first, then the most imported; the rest in folder order.
  missing.sort(
    (a, b) =>
      Number(a.kind === "panel") - Number(b.kind === "panel") ||
      (b.pages ?? 0) - (a.pages ?? 0) ||
      (b.importedBy ?? 0) - (a.importedBy ?? 0) ||
      (a.file < b.file ? -1 : 1),
  );
  return { files, covered: files - missing.length, missing };
}
