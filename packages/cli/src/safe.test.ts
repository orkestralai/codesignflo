import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hook } from "./commands/hook.js";
import { contains, tipOf } from "./git.js";
import { isBranchName, isTrustedServiceUrl, printable, projectId, proposalFolder, TRUSTED_ORIGINS } from "./safe.js";

describe("branch names from the service", () => {
  const good = ["main", "dev", "feature/new-badge", "release-1.2", "user/dana/x", "a@b"];
  const bad = [
    "",
    "-q",
    "--upload-pack=touch /tmp/x",
    "a..b",
    "a:b",
    "a b",
    "a\nb",
    "a\u0007b",
    "x/",
    "/x",
    ".x",
    "x/.y",
    "x.lock",
    "x.",
    "a@{1}",
    "a~1",
    "a^",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "@",
    "HEAD",
  ];
  it("accepts what git accepts", () => {
    for (const b of good) {
      expect(isBranchName(b), b).toBe(true);
      // Same verdict as git itself.
      expect(() => execFileSync("git", ["check-ref-format", "--branch", b], { stdio: "ignore" }), b).not.toThrow();
    }
  });
  it("refuses options, refspecs, ranges and control characters", () => {
    for (const b of bad) expect(isBranchName(b), JSON.stringify(b)).toBe(false);
  });
  it("never reach git", () => {
    expect(tipOf("--upload-pack=touch /tmp/pwned")).toBeNull();
    expect(contains("--output=/tmp/x", "abc123")).toBeNull();
  });
});

describe("names that become paths", () => {
  const base = "/repo/app/.codesignflo";
  it("component and proposal ids as CoDesignFlo makes them", () => {
    expect(proposalFolder(base, "pages.cart-page", "cmuy9vmkc")).toBe(join(base, "proposals", "pages.cart-page", "cmuy9vmkc"));
    expect(proposalFolder(base, "forms.text-input", "nmuxwt77l")).toBe(join(base, "proposals", "forms.text-input", "nmuxwt77l"));
  });
  it("anything that would climb out or nest is refused", () => {
    for (const [c, k] of [
      ["..", "c1"],
      [".", "c1"],
      ["../../.ssh", "c1"],
      ["button", "../../../etc"],
      ["a/b", "c1"],
      ["button", "c1/../../x"],
      ["/abs", "c1"],
      ["button", ""],
      ["but\u0000ton", "c1"],
    ])
      expect(() => proposalFolder(base, c, k), `${c} ${k}`).toThrow();
  });
  it("project ids", () => {
    expect(projectId("p_e3abff2f9ff1")).toBe("p_e3abff2f9ff1");
    for (const p of ["../x", "p_1/../../x", "", "a.b"]) expect(() => projectId(p)).toThrow();
  });
});

describe("the service's addresses", () => {
  it("CoDesignFlo's own and localhost only", () => {
    for (const u of [
      "https://codesignflo.com",
      "https://codesignflo.vercel.app/",
      "https://codesignflo-dev.vercel.app",
      "http://localhost:3317",
      "http://127.0.0.1:55321",
    ])
      expect(isTrustedServiceUrl(u, {}), u).toBe(true);
    for (const u of [
      "https://evil.example",
      "http://codesignflo.com",
      "https://codesignflo.com.evil.example",
      "https://user:pw@codesignflo.com",
      "file:///etc/passwd",
      "nonsense",
    ])
      expect(isTrustedServiceUrl(u, {}), u).toBe(false);
    expect(isTrustedServiceUrl("https://cdf.example.org", { CODESIGNFLO_TRUSTED_ORIGINS: "https://cdf.example.org" })).toBe(true);
  });
  it("lists the service's hosts in service/prod.json and service/staging.json", () => {
    for (const f of ["prod.json", "staging.json"]) {
      const c = JSON.parse(readFileSync(new URL(`../../../service/${f}`, import.meta.url), "utf8")) as { url: string; web: string };
      expect(TRUSTED_ORIGINS).toContain(new URL(c.url).origin);
      expect(TRUSTED_ORIGINS).toContain(new URL(c.web).origin);
    }
  });
  it("hook install --from an unknown host is refused before the code is sent", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(hook(["install", "--code", "abc", "--from", "https://evil.example"])).rejects.toThrow(/not a CoDesignFlo address/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("printing other people's text", () => {
  it("drops escape, control and bidi characters", () => {
    expect(printable("Shop\u001b[2J\u001b]0;pwned\u0007\r\nfile‮")).toBe("Shop[2J]0;pwnedfile");
    expect(printable("x".repeat(200), 10)).toBe(`${"x".repeat(10)}…`);
  });
});
