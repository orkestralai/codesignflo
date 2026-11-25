// A Live update only from a checkout that's up to date: never behind Live, never behind or split from the team.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { staleness } from "./live.js";

const was = process.cwd();
let repo = "";
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const commit = (name: string) => {
  writeFileSync(join(repo, "f.txt"), name);
  git("commit", "-qam", name);
  return git("rev-parse", "HEAD");
};

describe("staleness: who may update Live", () => {
  let c1 = "";
  let c2 = "";
  let c3 = "";
  let side = "";
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cdf-live-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "0");
    git("add", ".");
    git("commit", "-qm", "c0");
    c1 = commit("c1");
    c2 = commit("c2");
    c3 = commit("c3");
    git("checkout", "-q", "-b", "other", c1);
    side = commit("side");
    process.chdir(repo);
  });
  afterAll(() => {
    process.chdir(was);
    rmSync(repo, { recursive: true, force: true });
  });

  it("up to date, or ahead of the team (committed, not pushed yet): it may", () => {
    expect(staleness(c2, "main", c2, c1)).toBeNull();
    expect(staleness(c3, "main", c2, c2)).toBeNull();
    expect(staleness(c2, "main", null, null)).toBeNull();
  });
  it("behind what Live shows (another developer synced a newer main): pull first", () => {
    expect(staleness(c1, "main", c1, c3)).toMatch(/Live already shows main @.{7}, newer than yours.*pull main first/);
  });
  it("Live shows a commit this main doesn't have: pull first", () => {
    expect(staleness(side, "main", side, c2)).toMatch(/which your main doesn't have/);
  });
  it("behind the team's branch: pull first", () => {
    expect(staleness(c1, "main", c3, null)).toMatch(/your main is 2 commits behind origin\/main/);
  });
  it("split from the team's branch: pull first", () => {
    expect(staleness(side, "main", c3, null)).toMatch(/have split/);
  });
  it("what git can't tell doesn't hold it back", () => {
    expect(staleness(c2, "main", c2, "f".repeat(40))).toBeNull();
  });
});
