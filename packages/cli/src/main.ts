#!/usr/bin/env node
import { CLI_VERSION } from "./bridge/server.js";
import { ask } from "./commands/ask.js";
import { deliver } from "./commands/deliver.js";
import { delta } from "./commands/delta.js";
import { devReload } from "./commands/devreload.js";
import { hook } from "./commands/hook.js";
import { init } from "./commands/init.js";
import { branchCommand, liveBranchCommand, liveStatus } from "./commands/live.js";
import { login, logout, whoami } from "./commands/login.js";
import { name as nameCommand } from "./commands/name.js";
import { invite, people } from "./commands/people.js";
import { pull, pullProposals } from "./commands/pull.js";
import { resolve } from "./commands/resolve.js";
import { connect, plugin, serviceLine } from "./commands/selfhost.js";
import { stories } from "./commands/stories.js";
import { sync as realSync } from "./commands/sync.js";
import { verify } from "./commands/verify.js";
import { cloudSession, flushCloud, openCloud } from "./project.js";
// CoDesignFlo — command-line entry point. See docs/PHASE1.md for what each milestone adds.
import { flushTelemetry, recordCrash } from "./telemetry.js";

const commands: Record<string, { summary: string; run: (args: string[]) => Promise<number> | number }> = {
  init: {
    summary:
      "set up the open Figma file for this project (run in your app's folder) [--cloud: connect to the service; --project <id> | --new] [--skills]",
    run: (a) => init(a),
  },
  sync: {
    summary:
      "render Storybook, update Live, record the designer's work, verify delivered changes (--only a,b: update just these in Live; --preview: on a feature branch, show it in Figma beside Live)",
    run: (a) => realSync(a),
  },
  deliver: {
    summary:
      "apply a ready proposal to the code with Claude Code and commit it: deliver <component> (--track: hand-off only, you implement and commit)",
    run: (a) => deliver(a),
  },
  connect: {
    summary:
      "use a self-hosted CoDesignFlo: connect <box URL> (checks its config.json, trusts it from now on; then: login) | --cloud (back to the cloud) | no argument: which one is in use",
    run: (a) => connect(a),
  },
  plugin: {
    summary:
      "the Figma plugin for a self-hosted CoDesignFlo, ready to import: plugin build --server <box URL> [--out <dir>] (a folder and a zip)",
    run: (a) => plugin(a),
  },
  status: {
    summary:
      "what is waiting on the developer, and each component's state (no Figma needed) [--all: every place Live differs from the app]",
    run: async (a) => {
      const service = serviceLine();
      if (service) console.log(service);
      console.log((await import("./mcp.js")).statusText(process.cwd()));
      const cloud = cloudSession();
      if (cloud) for (const line of await liveStatus(cloud, undefined, a.includes("--all"))) console.log(line);
      return 0;
    },
  },
  proposal: {
    summary: "the designer's proposal for a component as implementation instructions: proposal <component> [--json]",
    run: async (a) => {
      const component = a.find((x) => !x.startsWith("--"));
      if (!component) throw new Error("usage: codesignflo proposal <component> [--json]");
      const p = (await import("./mcp.js")).proposalText(process.cwd(), component);
      console.log(a.includes("--json") ? JSON.stringify(p) : p.text);
      return 0;
    },
  },
  pull: { summary: "cloud projects: fetch the designer's proposals and compute their changes (no Figma needed)", run: () => pull() },
  stories: {
    summary: "the app's components that have no story yet (each story group becomes a component in Live) [--json] [--no-build]",
    run: (a) => stories(a),
  },
  login: { summary: "sign in to the CoDesignFlo service (opens the browser; nothing typed here) [--no-browser]", run: (a) => login(a) },
  whoami: { summary: "who you are signed in as", run: () => whoami() },
  logout: { summary: "revoke this machine's sign-in [--everywhere: every session of the account]", run: (a) => logout(a) },
  invite: {
    summary:
      "cloud projects: invite someone by email: invite <email> [--designer (default) | --developer | --admin] (emails them how to join; --resend: send it again)",
    run: (a) => invite(a),
  },
  people: { summary: "cloud projects: who is in this app's project", run: () => people() },
  "live-branch": {
    summary: "cloud projects: which branch updates Live: live-branch [<name>] (developers and admins)",
    run: (a) => liveBranchCommand(a, cloudSession()),
  },
  branch: {
    summary:
      "cloud projects: branches with a lane beside Live in Figma, updated by every sync on them: branch [connect | disconnect] [<name>] (developers and admins)",
    run: (a) => branchCommand(a, cloudSession()),
  },
  hook: {
    summary: "cloud projects: update Live on every commit to the Live branch (git hook on this machine): hook install | remove",
    run: (a) => hook(a),
  },
  ask: { summary: 'send a ready proposal back to the designer with a question: ask <component> "<question>"', run: (a) => ask(a) },
  mcp: {
    summary: "run the MCP server for coding agents (stdio): claude mcp add --scope user codesignflo -- npx -y @codesignflo/cli mcp",
    run: async () => (await import("./mcp.js")).mcp(),
  },
  resolve: {
    summary: 'settle a clash between the designer\'s copy and code changed meanwhile: resolve <component> --design | --code "<why>"',
    run: (a) => resolve(a),
  },
  delta: {
    summary: "show what the designer changed in proposals marked ready for dev (writes .codesignflo/proposals/…)",
    run: () => delta(),
  },
  verify: {
    summary: "compare Live with the code, variant by variant (browser vs Figma images) [component…] [--screens] [--strict]",
    run: (a) => verify(a),
  },
  name: { summary: "give unnamed elements semantic layer names in code (data-cdf) with Claude Code [--check]", run: (a) => nameCommand(a) },
  "dev:reload": { summary: "(development) hot-swap the running plugin with the current build", run: () => devReload() },
  version: {
    summary: "print the version",
    run: () => {
      console.log(CLI_VERSION);
      return 0;
    },
  },
};

const [name = "help", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.log("usage: codesignflo <command>\n");
  for (const [n, c] of Object.entries(commands)) console.log(`  ${n.padEnd(10)} ${c.summary}`);
  process.exit(name === "help" ? 0 : 1);
}
// Cloud projects: the history is loaded from the service first and saved back at the end (also after errors).
const local = [
  "connect",
  "plugin",
  "login",
  "logout",
  "whoami",
  "invite",
  "people",
  "hook",
  "mcp",
  "version",
  "help",
  "init",
  "dev:reload",
  "stories",
].includes(name);
let code = 1;
try {
  if (!local) await openCloud();
  // Cloud projects: proposals come from the service before anything that implements or answers them.
  if (["deliver", "ask", "resolve", "verify", "status", "proposal"].includes(name)) await pullProposals();
  code = await command.run(args);
} catch (e) {
  console.error(`codesignflo ${name}: ${(e as Error).message}`);
  recordCrash(name, e as Error);
  // Where it failed, for the bug report (the message alone didn't say which code or page).
  const where = ((e as Error).cause as Error | undefined)?.stack ?? (e as Error).stack;
  if (where) console.error(where.split("\n").slice(1, 8).join("\n"));
} finally {
  try {
    await flushCloud();
  } catch (e) {
    console.error(`codesignflo ${name}: ${(e as Error).message}`);
    code = 1;
  }
  await flushTelemetry();
}
process.exit(code);
