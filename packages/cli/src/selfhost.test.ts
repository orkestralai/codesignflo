import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isTrustedServiceUrl } from "./safe.js";
import { boxOrigin, fetchBoxConfig, PLACEHOLDER, parseBoxConfig, pluginId, writePlugin } from "./selfhost.js";

const ANON = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
const tmp = mkdtempSync(join(tmpdir(), "cdf-selfhost-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A box answering /config.json with `body` (and the URLs it was asked for). */
function box(body: unknown, status = 200) {
  const asked: string[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    asked.push(String(url));
    expect(init?.redirect).toBe("error");
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: f, asked };
}
const selfhost = (origin: string, extra: Record<string, unknown> = {}) => ({
  mode: "selfhost",
  url: origin,
  anon: ANON,
  mcpUrl: `${origin}/mcp`,
  ...extra,
});

/** A template as packages/plugin/scripts/build.mjs makes it (the real one is checked by the pack step). */
function fakeTemplate(): string {
  const t = join(tmp, "template");
  mkdirSync(join(t, "dist"), { recursive: true });
  const service = `var P={url:${JSON.stringify(PLACEHOLDER.url)},anon:${JSON.stringify(PLACEHOLDER.anon)},web:${JSON.stringify(PLACEHOLDER.web)},mode:"selfhost"};`;
  writeFileSync(join(t, "dist", "code.js"), `(()=>{${service}figma.showUI(__html__);})();`);
  writeFileSync(join(t, "dist", "ui.html"), "<html><script>let a=1</script></html>");
  writeFileSync(
    join(t, "manifest.json"),
    JSON.stringify({
      name: "CoDesignFlo (self-hosted)",
      id: "codesignflo-selfhost",
      api: "1.0.0",
      main: "dist/code.js",
      ui: "dist/ui.html",
      networkAccess: { allowedDomains: ["ws://localhost:4517"], reasoning: "x" },
    }),
  );
  writeFileSync(join(t, "template.json"), JSON.stringify({ version: "9.9.9", placeholder: { ...PLACEHOLDER, mode: "selfhost" } }));
  return t;
}

describe("the plugin template's placeholders", () => {
  it("are the ones the plugin's build script puts in", () => {
    const build = readFileSync(new URL("../../plugin/scripts/build.mjs", import.meta.url), "utf8");
    for (const v of Object.values(PLACEHOLDER)) expect(build).toContain(`"${v}"`);
  });
});

describe("a box's address and config.json", () => {
  it("https anywhere; plain http only on this machine or the local network", () => {
    expect(boxOrigin("https://box.example.com/some/path").origin).toBe("https://box.example.com");
    expect(boxOrigin("laptop.tailnet.ts.net").origin).toBe("https://laptop.tailnet.ts.net");
    for (const u of [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://192.168.1.20:8080",
      "http://10.0.0.5",
      "http://100.101.102.103",
      "http://nas.local",
    ])
      expect(() => boxOrigin(u), u).not.toThrow();
    for (const u of ["http://box.example.com", "http://8.8.8.8", "ftp://box.example.com", "https://u:p@box.example.com", "nonsense url"])
      expect(() => boxOrigin(u), u).toThrow();
  });
  it("refuses a config that isn't a self-hosted box's, or names another host", () => {
    const b = new URL("https://box.example.com");
    expect(() => parseBoxConfig({ url: "https://box.example.com", anon: ANON }, b)).toThrow(/not a self-hosted/);
    expect(() => parseBoxConfig({ mode: "cloud", url: "https://box.example.com", anon: ANON }, b)).toThrow(/not a self-hosted/);
    expect(() => parseBoxConfig(selfhost("https://evil.example"), b)).toThrow(/not on https:\/\/box.example.com/);
    expect(() => parseBoxConfig(selfhost("https://box.example.com", { mcpUrl: "https://evil.example/mcp" }), b)).toThrow(/MCP/);
    expect(() => parseBoxConfig(selfhost("https://box.example.com", { anon: 'x"</script>' }), b)).toThrow(/anon/);
    expect(parseBoxConfig(selfhost("https://box.example.com", { mcpUrl: undefined }), b)).toMatchObject({
      url: "https://box.example.com",
      web: "https://box.example.com",
      mcpUrl: "https://box.example.com/mcp",
    });
  });
  it("refuses a box that can't be reached or isn't one", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchBoxConfig("https://box.example.com", down)).rejects.toThrow(/couldn't reach https:\/\/box.example.com\/config.json/);
    await expect(fetchBoxConfig("https://box.example.com", box({}, 404).fetch)).rejects.toThrow(/answered 404/);
    await expect(fetchBoxConfig("https://box.example.com", box({ url: "x", anon: ANON }).fetch)).rejects.toThrow(/not a self-hosted/);
    const b = box(selfhost("https://box.example.com"));
    await fetchBoxConfig("https://box.example.com/", b.fetch);
    expect(b.asked).toEqual(["https://box.example.com/config.json"]);
  });
});

describe("codesignflo plugin build", () => {
  let template: string;
  beforeAll(() => {
    template = fakeTemplate();
    process.env.CODESIGNFLO_PLUGIN_TEMPLATE = template;
  });
  afterAll(() => {
    delete process.env.CODESIGNFLO_PLUGIN_TEMPLATE;
  });
  const build = async (server: string, config: unknown, out: string) => {
    const { plugin } = await import("./commands/selfhost.js");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await plugin(["build", "--server", server, "--out", out], box(config).fetch)).toBe(0);
    } finally {
      log.mockRestore();
    }
    return {
      manifest: JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")),
      code: readFileSync(join(out, "dist", "code.js"), "utf8"),
    };
  };

  it("https box: its service in the bundle, its own id, name and domains", async () => {
    const out = join(tmp, "https");
    const { manifest, code } = await build("https://box.example.com", selfhost("https://box.example.com"), out);
    expect(manifest.id).toBe(pluginId("https://box.example.com"));
    expect(manifest.id).toMatch(/^codesignflo-selfhost-[0-9a-f]{10}$/);
    expect(manifest.name).toBe("CoDesignFlo (box.example.com)");
    expect(manifest.networkAccess.allowedDomains).toEqual(["https://box.example.com", "wss://box.example.com", "ws://localhost:4517"]);
    expect(manifest.networkAccess.devAllowedDomains).toBeUndefined();
    expect(code).not.toContain("__CODESIGNFLO_SELFHOST_");
    expect(code).toContain(`{url:"https://box.example.com",anon:"${ANON}",web:"https://box.example.com",mode:"selfhost"}`);
    expect(existsSync(`${out}.zip`)).toBe(true);
    try {
      const list = execFileSync("unzip", ["-l", `${out}.zip`], { encoding: "utf8" });
      expect(list).toContain("CoDesignFlo/manifest.json");
      expect(list).toContain("CoDesignFlo/dist/code.js");
      execFileSync("unzip", ["-tq", `${out}.zip`]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // no unzip on this machine
    }
  });

  it("http://localhost (and 127.0.0.1, which Figma's manifest doesn't take): ws:// and dev domains", async () => {
    const out = join(tmp, "local");
    const { manifest, code } = await build("http://127.0.0.1:8080", selfhost("http://127.0.0.1:8080"), out);
    expect(manifest.name).toBe("CoDesignFlo (localhost:8080)");
    expect(manifest.id).toBe(pluginId("http://localhost:8080"));
    expect(manifest.networkAccess.allowedDomains).toEqual(["http://localhost:8080", "ws://localhost:8080", "ws://localhost:4517"]);
    expect(manifest.networkAccess.devAllowedDomains).toEqual(manifest.networkAccess.allowedDomains);
    expect(code).toContain(`url:"http://localhost:8080"`);
    expect(code).not.toContain("127.0.0.1");
  });

  it("a Tailscale address, with the API under a path", async () => {
    const origin = "https://laptop.tailnet.ts.net";
    const { manifest, code } = await build(origin, selfhost(origin, { url: `${origin}/supabase` }), join(tmp, "tailnet"));
    expect(manifest.name).toBe("CoDesignFlo (laptop.tailnet.ts.net)");
    expect(manifest.networkAccess.allowedDomains).toEqual([origin, "wss://laptop.tailnet.ts.net", "ws://localhost:4517"]);
    expect(code).toContain(`url:"${origin}/supabase"`);
  });

  it("different boxes are different plugins", () => {
    expect(pluginId("https://a.example.com")).not.toBe(pluginId("https://b.example.com"));
  });

  it("refuses a box whose config isn't selfhost, or that's down, and writes nothing", async () => {
    const { plugin } = await import("./commands/selfhost.js");
    const out = join(tmp, "refused");
    await expect(
      plugin(["build", "--server", "https://box.example.com", "--out", out], box({ url: "https://box.example.com", anon: ANON }).fetch),
    ).rejects.toThrow(/not a self-hosted/);
    const down = vi.fn(async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(plugin(["build", "--server", "http://localhost:9", "--out", out], down)).rejects.toThrow(/couldn't reach/);
    expect(existsSync(out)).toBe(false);
  });

  it("refreshes its own folder in place, never someone else's", async () => {
    const out = join(tmp, "https");
    await build("https://box.example.com", selfhost("https://box.example.com"), out);
    const other = join(tmp, "other");
    mkdirSync(other);
    writeFileSync(join(other, "notes.txt"), "mine");
    expect(() =>
      writePlugin(parseBoxConfig(selfhost("https://box.example.com"), new URL("https://box.example.com")), other, template),
    ).toThrow(/pick another --out/);
  });
});

describe("codesignflo connect", () => {
  const home = join(tmp, "home");
  const realHome = process.env.HOME;
  beforeAll(() => {
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    vi.resetModules();
  });
  afterAll(() => {
    process.env.HOME = realHome;
    vi.resetModules();
  });
  const quiet = async <T>(f: () => Promise<T>) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      return await f();
    } finally {
      log.mockRestore();
    }
  };
  const read = (f: string) => JSON.parse(readFileSync(join(home, ".codesignflo", f), "utf8"));

  it("saves the box as the service, trusts its origin, and forgets the old sign-in", async () => {
    const { connect, mcpLines, serviceLine } = await import("./commands/selfhost.js");
    const { saveSession, hasSession } = await import("./service/client.js");
    const origin = "https://box.example.com";
    // Never the real ~/.codesignflo.
    expect(homedir()).toBe(home);
    saveSession("old-refresh-token", { id: "u1" });
    expect(isTrustedServiceUrl(origin, {})).toBe(false);
    expect(await quiet(() => connect([origin], box(selfhost(origin)).fetch))).toBe(0);
    expect(read("service.json")).toEqual({ url: origin, anon: ANON, web: origin, mode: "selfhost", box: origin, mcpUrl: `${origin}/mcp` });
    expect(read("trusted-origins.json")).toEqual({ origins: [origin] });
    expect(isTrustedServiceUrl(`${origin}/mcp`, {})).toBe(true);
    expect(isTrustedServiceUrl("https://evil.example", {})).toBe(false);
    expect(hasSession()).toBe(false);
    expect(mcpLines()[0]).toBe(`  claude mcp add --transport http --scope user codesignflo ${origin}/mcp`);
    expect(serviceLine()).toContain(origin);
  });

  it("a refused box changes nothing", async () => {
    const { connect } = await import("./commands/selfhost.js");
    await expect(connect(["https://other.example.com"], box({ mode: "cloud" }).fetch)).rejects.toThrow(/not a self-hosted/);
    expect(read("trusted-origins.json")).toEqual({ origins: ["https://box.example.com"] });
    expect(read("service.json").box).toBe("https://box.example.com");
  });

  it("--cloud goes back: the hosted service, no extra trusted origin", async () => {
    const { connect, mcpLines, serviceLine } = await import("./commands/selfhost.js");
    const { HOSTED } = await import("./service/client.js");
    expect(await quiet(() => connect(["--cloud"]))).toBe(0);
    expect(read("service.json")).toEqual(HOSTED);
    expect(existsSync(join(home, ".codesignflo", "trusted-origins.json"))).toBe(false);
    expect(isTrustedServiceUrl("https://box.example.com", {})).toBe(false);
    expect(serviceLine()).toBeNull();
    expect(mcpLines()[0]).toBe("  claude mcp add --scope user codesignflo -- npx -y @codesignflo/cli mcp");
  });
});

describe("cloud defaults", () => {
  it("the hosted service is service/prod.json", async () => {
    const { HOSTED } = await import("./service/client.js");
    const prod = JSON.parse(readFileSync(new URL("../../../service/prod.json", import.meta.url), "utf8"));
    expect(HOSTED).toEqual({ url: prod.url, anon: prod.anon, web: prod.web });
  });
  it("a trust file can only add whole origins", async () => {
    const { savedTrustedOrigins } = await import("./safe.js");
    const f = join(tmp, "trusted.json");
    writeFileSync(
      f,
      JSON.stringify({ origins: ["https://ok.example", "https://ok.example/path", "javascript:alert(1)", 3, "https://u:p@x.example"] }),
    );
    expect(savedTrustedOrigins(f)).toEqual(["https://ok.example"]);
    writeFileSync(f, "not json");
    expect(savedTrustedOrigins(f)).toEqual([]);
  });
});
