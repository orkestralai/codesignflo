// Git helpers: current commit, and CoDesignFlo trailers on commits since a given one.
import { execFileSync } from "node:child_process";
import { isBranchName, isCommit } from "./safe.js";

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

export function head(): string {
  try {
    return git(["rev-parse", "HEAD"]);
  } catch {
    return "uncommitted";
  }
}

/** Current branch name ("HEAD" when detached; null outside git). */
export function branch(): string | null {
  try {
    return git(["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return null;
  }
}

export type Trailer = { commit: string; component: string; claim: string; items: string[] };

/**
 * `CoDesignFlo: <component> claim=<id> items=C1,C2` lines in commits after `since` (all reachable if
 * unknown). Read from the whole message, not only git's trailer block: a line written in its own
 * paragraph (before a Co-Authored-By paragraph, say) is not a trailer to git but is still meant.
 */
export function trailersSince(since: string | undefined): Trailer[] {
  let out: string;
  try {
    const range = since && isCommit(since) ? [`${since}..HEAD`] : ["HEAD"];
    out = git(["log", "--format=%H%x1f%B%x1e", ...range]);
  } catch {
    return [];
  }
  return parseTrailers(out);
}

/** Parses `git log --format=%H%x1f%B%x1e` output. */
export function parseTrailers(log: string): Trailer[] {
  const found: Trailer[] = [];
  for (const rec of log.split("\x1e")) {
    const [commit, body] = rec.trim().split("\x1f");
    if (!commit || !body) continue;
    for (const line of body.split("\n")) {
      // "CoDesignLoop:" is the line's name before the rename; both are read.
      const m = /^CoDesign(?:Flo|Loop):\s*(\S+)\s+claim=(\S+)(?:\s+items=(\S+))?\s*$/.exec(line.trim());
      if (m) found.push({ commit, component: m[1]!, claim: m[2]!, items: m[3] ? m[3].split(",") : [] });
    }
  }
  return found;
}

/** Uncommitted (or untracked) files in this folder (the app), CoDesignFlo's own folder aside. */
export function dirtyFiles(): string[] {
  try {
    return (
      git(["status", "--porcelain", "--", ".", ":(exclude).codesignflo", ":(exclude).codesignloop"])
        .split("\n")
        .filter(Boolean)
        // "XY path": the status is one or two characters (the first line's leading space is trimmed away).
        .map((l) => l.replace(/^[ MADRCU?!T]{1,2} /, ""))
    );
  } catch {
    return [];
  }
}
export const dirty = () => dirtyFiles().length > 0;

/**
 * Files that can't change what Storybook draws: notes and docs, scripts, tests, CI — work in progress in
 * them doesn't stop a Live update (a doc and a script being edited held one back). More in config "liveIgnore".
 */
const NOT_RENDERED = [
  /\.(md|txt|rst|log)$/i,
  /(^|\/)(docs?|scripts|e2e|\.github|\.vscode|\.idea)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__)\//,
];
export function affectsRender(path: string, ignore: string[] = []): boolean {
  if (NOT_RENDERED.some((r) => r.test(path))) return false;
  return !ignore.some((pattern) => {
    const re = new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\/?/g, "§")
        .replace(/\*/g, "[^/]*")
        .replace(/§/g, ".*")}$`,
    );
    return re.test(path);
  });
}

/** The remote's default branch (origin/HEAD), else main/master if they exist, else the current branch. */
export function defaultBranch(): string | null {
  try {
    return git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    for (const b of ["main", "master"])
      try {
        git(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
        return b;
      } catch {
        // next
      }
    return branch();
  }
}

/**
 * The Live branch's tip as the team sees it: origin/<branch> after a quiet fetch (the developer's own git
 * credentials; no access for the service), else the local branch.
 */
export function tipOf(liveBranch: string): string | null {
  // The name comes from the service: only a real branch name, and only as an explicit refspec after "--".
  if (!isBranchName(liveBranch)) return null;
  try {
    execFileSync("git", ["fetch", "--quiet", "--", "origin", `+refs/heads/${liveBranch}:refs/remotes/origin/${liveBranch}`], {
      stdio: "ignore",
      timeout: 20_000,
    });
  } catch {
    // offline or no remote: the local branch will do
  }
  for (const ref of [`refs/remotes/origin/${liveBranch}`, `refs/heads/${liveBranch}`])
    try {
      return git(["rev-parse", "--verify", "--quiet", ref]);
    } catch {
      // next
    }
  return null;
}

/** Is `commit` part of `tip`'s history (merged)? null when git can't tell (commit unknown here). */
export function contains(tip: string, commit: string): boolean | null {
  // Commits come from the service: hex ids only, never something git reads as an option.
  if (!isCommit(tip) || !isCommit(commit)) return null;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, tip], { stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : null;
  }
}

/** Commits in `tip` that `from` doesn't have (null when unknown). */
export function behind(from: string, tip: string): number | null {
  if (!isCommit(from) || !isCommit(tip)) return null;
  try {
    return Number(git(["rev-list", "--count", `${from}..${tip}`]));
  } catch {
    return null;
  }
}

/** Did anything in this folder (the app) change between `from` and HEAD? null when unknown. */
export function changedSince(from: string): boolean | null {
  if (!isCommit(from)) return null;
  try {
    execFileSync("git", ["diff", "--quiet", from, "HEAD", "--", ".", ":(exclude).codesignflo"], { stdio: "ignore" });
    return false;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? true : null;
  }
}

/**
 * Are these files the same at `commit` and at `tip`? A squash merge leaves no trace in history (the branch's
 * commit isn't an ancestor of the tip), but the files it brought are identical. null when git can't tell.
 */
export function sameFiles(commit: string, tip: string, files: string[]): boolean | null {
  if (!files.length || !isCommit(commit) || !isCommit(tip)) return null;
  try {
    execFileSync("git", ["diff", "--quiet", commit, tip, "--", ...files], { stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number }).status === 1 ? false : null;
  }
}
