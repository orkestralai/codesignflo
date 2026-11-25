import { describe, expect, it } from "vitest";
import { liveStateLine } from "./livestate.js";

const now = Date.parse("2026-11-11T15:00:00Z");
const at = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
const applied = { commit: "5417d06aaaa", status: "applied", created_at: at(120) };

describe("where Live stands", () => {
  it("nothing yet; applied", () => {
    expect(liveStateLine("dev", null, null, null, now)).toBe("Live: nothing uploaded from dev yet — sync on dev");
    expect(liveStateLine("dev", applied, applied, null, now)).toBe("Live: dev @5417d06");
  });

  it("names the CLI version that made the update, when it was saved with it", () => {
    const by = { ...applied, cli: "0.2.4" };
    expect(liveStateLine("dev", by, by, null, now)).toBe("Live: dev @5417d06 (CLI 0.2.4)");
    const pending = { commit: "9999999aaa", status: "pending", created_at: at(3), cli: "0.2.5" };
    expect(liveStateLine("dev", pending, by, at(30), now)).toMatch(
      /^Live: dev @5417d06 \(CLI 0\.2\.4\); the update @9999999 \(CLI 0\.2\.5\) \(uploaded/,
    );
  });

  it("waiting: the file closed, or open and about to take it", () => {
    const pending = { commit: "9999999aaa", status: "pending", created_at: at(3) };
    expect(liveStateLine("dev", pending, applied, at(30), now)).toBe(
      "Live: dev @5417d06; the update @9999999 (uploaded 3 min ago) waits for the Figma file to be opened with the CoDesignFlo plugin",
    );
    expect(liveStateLine("dev", pending, applied, at(0.2), now)).toMatch(/is about to be applied: the plugin is open/);
  });

  it("applying: what the plugin is doing; quiet: never tells to close it while it may still work", () => {
    const applying = {
      commit: "9999999aaa",
      status: "applying",
      created_at: at(15),
      taken_at: at(0.5),
      progress: { done: 12, total: 52, item: "last: pages.crm" },
    };
    expect(liveStateLine("dev", applying, applied, at(0.1), now)).toBe(
      "Live: dev @5417d06; the update @9999999 (uploaded 15 min ago) is being applied in Figma: 12 of 52 components and pages (last: pages.crm)",
    );
    const loading = { ...applying, progress: { done: 0, total: 52, item: "downloading pictures: 12 of 40" } };
    expect(liveStateLine("dev", loading, applied, at(0.1), now)).toMatch(
      /0 of 52 components and pages \(downloading pictures: 12 of 40\)$/,
    );
    const behind = { ...applying, progress: { ...applying.progress, background: true } };
    expect(liveStateLine("dev", behind, applied, at(0.1), now)).toMatch(
      /Figma is in the background, which slows the plugin down: bring the Figma window to the front$/,
    );
    // Quiet for a while: may still be working (a background window) — wait, don't close it.
    const quiet = { ...applying, taken_at: at(4) };
    const q = liveStateLine("dev", quiet, applied, at(4), now);
    expect(q).toMatch(
      /no sign from the plugin for 4 min, at 12 of 52 .*bring its window to the front and wait \(closing the plugin would start the update over\)/,
    );
    expect(q).not.toMatch(/reopen/);
    // Gone (another plugin may take it over now): open the plugin.
    const gone = { ...applying, taken_at: at(12) };
    expect(liveStateLine("dev", gone, applied, at(12), now)).toMatch(
      /stopped at 12 of 52 .*open the CoDesignFlo plugin in the Figma file and it starts the update over$/,
    );
  });

  it("failed: why, and Live still shows the last applied", () => {
    const failed = {
      commit: "9999999aaa",
      status: "failed",
      created_at: at(5),
      log: "badge  updated\ncouldn't update Live: out of memory",
    };
    expect(liveStateLine("dev", failed, applied, null, now)).toBe(
      "Live: dev @5417d06; applying the update @9999999 (uploaded 5 min ago) failed in Figma: couldn't update Live: out of memory — sync again to retry",
    );
  });
});
