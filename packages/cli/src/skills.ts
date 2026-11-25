// Claude Code skills shipped with the CLI (skills/*/SKILL.md), installed into the project's .claude/skills/.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const shipped = fileURLToPath(new URL("../skills", import.meta.url));

/** Copies (or refreshes) every shipped skill into <repo root>/.claude/skills/. Returns the folder. */
export function installSkills(cwd = process.cwd()): { folder: string; skills: string[] } {
  let repo = cwd;
  try {
    repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    // not a git repo: install next to the project
  }
  const folder = join(repo, ".claude", "skills");
  mkdirSync(folder, { recursive: true });
  const skills = readdirSync(shipped).filter((d) => existsSync(join(shipped, d, "SKILL.md")));
  for (const s of skills) cpSync(join(shipped, s), join(folder, s), { recursive: true });
  return { folder: relative(cwd, folder) || ".", skills };
}
