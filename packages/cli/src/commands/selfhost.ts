// codesignflo connect <box> | --cloud — which CoDesignFlo service this machine uses: a team's self-hosted box or
// the cloud. codesignflo plugin build --server <box> — the Figma plugin for a box, ready to import.
import { type BoxConfig, boxOrigin, defaultOut, fetchBoxConfig, shown, writePlugin } from "../selfhost.js";
import {
  forgetSession,
  HOSTED,
  hasSession,
  type ServiceConfig,
  savedService,
  saveService,
  saveTrustedOrigins,
  selfhostService,
} from "../service/client.js";

const opt = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** How an agent adds the MCP server: the box's own hosted MCP when connected to a box. */
export function mcpLines(service: ServiceConfig | null = selfhostService()): string[] {
  if (service?.mcpUrl)
    return [
      `  claude mcp add --transport http --scope user codesignflo ${service.mcpUrl}`,
      "  (or run it on this machine: claude mcp add --scope user codesignflo -- npx -y @codesignflo/cli mcp)",
    ];
  return [
    "  claude mcp add --scope user codesignflo -- npx -y @codesignflo/cli mcp",
    "  (other MCP agents: command `npx -y @codesignflo/cli mcp`; legacy Claude Code skills: codesignflo init --skills)",
  ];
}

/** One line on the service in use, for status: only when it isn't the cloud (the cloud's output is unchanged). */
export function serviceLine(): string | null {
  const s = selfhostService();
  return s ? `service: self-hosted box ${s.box ?? new URL(s.web).origin} (back to the cloud: codesignflo connect --cloud)` : null;
}

/** A change of service: the saved sign-in belongs to the old one and never goes to the new one. */
function switchTo(next: ServiceConfig, trusted: string[]) {
  const before = savedService();
  const moved = !before || before.url !== next.url || before.anon !== next.anon;
  saveTrustedOrigins(trusted);
  saveService(next);
  if (moved && hasSession()) {
    forgetSession();
    return true;
  }
  return false;
}

export async function connect(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const env = process.env.CODESIGNFLO_SERVICE_URL && process.env.CODESIGNFLO_SERVICE_ANON;
  if (args.includes("--cloud")) {
    const signedOut = switchTo(HOSTED, []);
    console.log(`this machine now uses the CoDesignFlo cloud (${HOSTED.web})`);
    if (signedOut) console.log("the sign-in for the previous service was forgotten here");
    console.log("next: codesignflo login");
    if (env) console.log("note: CODESIGNFLO_SERVICE_URL is set in this shell and still wins over this choice");
    return 0;
  }
  const box = args.find((a) => !a.startsWith("--"));
  if (!box) {
    const s = selfhostService();
    console.log(
      env
        ? `service: ${process.env.CODESIGNFLO_SERVICE_URL} (from CODESIGNFLO_SERVICE_URL)`
        : s
          ? `service: self-hosted box ${s.box}`
          : savedService()
            ? `service: the CoDesignFlo cloud (${savedService()!.web})`
            : "service: not chosen yet (the CoDesignFlo cloud through its MCP)",
    );
    console.log("usage: codesignflo connect <box URL> (a self-hosted CoDesignFlo) | --cloud");
    return 0;
  }
  const cfg = await fetchBoxConfig(box, fetchImpl);
  const signedOut = switchTo({ url: cfg.url, anon: cfg.anon, web: cfg.web, mode: "selfhost", box: cfg.origin, mcpUrl: cfg.mcpUrl }, [
    cfg.origin,
  ]);
  console.log(
    `this machine now uses the self-hosted CoDesignFlo at ${cfg.origin} (trusted from now on; back: codesignflo connect --cloud)`,
  );
  if (signedOut) console.log("the sign-in for the previous service was forgotten here");
  console.log("next: codesignflo login");
  console.log("coding agents (once per machine):");
  for (const l of mcpLines({ ...cfg, mode: "selfhost" })) console.log(l);
  console.log(`designers: the Figma plugin for this box: codesignflo plugin build --server ${cfg.origin}`);
  if (env) console.log("note: CODESIGNFLO_SERVICE_URL is set in this shell and still wins over this box");
  return 0;
}

/** codesignflo plugin build --server <box> [--out <dir>] */
export async function plugin(args: string[], fetchImpl: typeof fetch = fetch): Promise<number> {
  const server = opt(args, "--server");
  if (args[0] !== "build" || !server)
    throw new Error("usage: codesignflo plugin build --server <box URL> [--out <dir>] (the Figma plugin for a self-hosted CoDesignFlo)");
  // Figma's manifest accepts "localhost", not IP addresses: a box on this machine is localhost.
  const typed = boxOrigin(server);
  if (["127.0.0.1", "[::1]"].includes(typed.hostname)) typed.hostname = "localhost";
  const cfg: BoxConfig = await fetchBoxConfig(typed.origin, fetchImpl);
  const r = writePlugin(cfg, opt(args, "--out") ?? defaultOut(cfg.origin));
  console.log(`built the CoDesignFlo plugin ${r.version} for ${cfg.origin}: ${shown(r.dir)} (and ${shown(r.zip)})`);
  console.log(`  id ${r.manifest.id}, name "${r.manifest.name}"`);
  console.log("import it in the Figma desktop app: Plugins → Development → Import plugin from manifest… → its manifest.json");
  const host = new URL(cfg.origin).hostname;
  if (/^[\d.]+$|^\[/.test(host) && host !== "localhost")
    console.log(
      `note: Figma may refuse an IP address (${host}) in a plugin's allowed domains: if the import complains, give the box a host name (a Tailscale name, *.local, or DNS) and build again`,
    );
  return 0;
}
