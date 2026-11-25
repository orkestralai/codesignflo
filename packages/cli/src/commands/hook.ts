// codesignflo hook install | remove — keeps Live up to date on every commit to the Live branch (cloud
// projects). Git runs the hook after each commit and after each pull/merge; it starts a background sync that
// does nothing on other branches. It lives in .git/hooks (this machine only): never committed, never in the
// repo. Repos that manage hooks with a tool (core.hooksPath: husky, lefthook…) get told what to add instead.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_VERSION } from "../bridge/server.js";
import { readConfig } from "../project.js";
import { projectId as safeProjectId, trustedServiceUrl } from "../safe.js";
import { ensureHome, hasSession, type ServiceConfig, saveService, saveSession, serviceConfig, signedIn } from "../service/client.js";
import { login } from "./login.js";

const BEGIN = "# >>> codesignflo: update Live on commits to the Live branch";
const END = "# <<< codesignflo";
const HOOKS = ["post-commit", "post-merge"];

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** How the hook starts this CLI: the same version through npx, or this checkout (development). */
function command(): string {
  const main = fileURLToPath(new URL("../main.js", import.meta.url));
  return main.includes("/_npx/") || main.includes("/node_modules/codesignflo/") || main.includes("/node_modules/@codesignflo/cli/")
    ? // Absolute: git apps run hooks with a short PATH.
      `${quote(join(dirname(process.execPath), "npx"))} -y @codesignflo/cli@${CLI_VERSION}`
    : `${quote(process.execPath)} ${quote(main)}`;
}

function block(app: string, projectId: string): string {
  const log = join(homedir(), ".codesignflo", "logs", `${safeProjectId(projectId)}.log`);
  return `${BEGIN} (remove: codesignflo hook remove)
( cd ${quote(app)} && nohup ${command()} sync --from-hook >> ${quote(log)} 2>&1 & ) >/dev/null 2>&1
${END}
`;
}

/** Where git looks for hooks; null when a hook manager owns them (core.hooksPath). */
function hooksDir(): { dir: string | null; managedBy?: string } {
  let managed = "";
  try {
    managed = git(["config", "--get", "core.hooksPath"]);
  } catch {
    // not set
  }
  if (managed) return { dir: null, managedBy: managed };
  return { dir: resolve(git(["rev-parse", "--git-path", "hooks"])) };
}

const strip = (text: string) => text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g"), "");

export function installHook(): { ok: boolean; message: string } {
  const c = readConfig();
  if (!c?.cloud) return { ok: false, message: "the hook is for projects connected to the service (init --cloud)" };
  const { dir, managedBy } = hooksDir();
  const line = `${command()} sync --from-hook`;
  if (!dir)
    return {
      ok: false,
      message: `this repo's hooks are managed in ${managedBy} (husky, lefthook…), which is part of the repo. To keep Live updated on commits, add this to its post-commit and post-merge hooks — or skip it: the agent syncs after its own commits.\n  (cd ${quote(process.cwd())} && nohup ${line} >/dev/null 2>&1 &)`,
    };
  mkdirSync(dir, { recursive: true });
  ensureHome();
  mkdirSync(join(homedir(), ".codesignflo", "logs"), { recursive: true, mode: 0o700 });
  for (const name of HOOKS) {
    const file = join(dir, name);
    const before = existsSync(file) ? strip(readFileSync(file, "utf8")) : "#!/bin/sh\n";
    writeFileSync(file, `${before.endsWith("\n") ? before : `${before}\n`}${block(process.cwd(), c.projectId)}`);
    chmodSync(file, 0o755);
  }
  return {
    ok: true,
    message: `Live updates on every commit to the Live branch on this machine (git hooks post-commit and post-merge in ${dir}; not part of the repo). Log: ~/.codesignflo/logs/${c.projectId}.log`,
  };
}

export function removeHook(): string {
  const { dir } = hooksDir();
  if (!dir) return "nothing to remove (hooks are managed by the repo's hook tool)";
  let n = 0;
  for (const name of HOOKS) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const left = strip(text);
    if (left === text) continue;
    // Only ours was there: remove the file rather than leave an empty hook.
    if (left.trim() === "#!/bin/sh") rmSync(file);
    else writeFileSync(file, left);
    n++;
  }
  return n
    ? "removed: commits no longer update Live by themselves (to also revoke this machine's sign-in: codesignflo logout)"
    : "no CoDesignFlo hook here";
}

export async function hook(args: string[]): Promise<number> {
  if (args[0] === "remove") {
    console.log(removeHook());
    return 0;
  }
  if (args[0] !== "install") throw new Error("usage: codesignflo hook install [--code <one-time code> --from <MCP address>] | remove");
  // The hook runs on its own after commits: it needs this machine's own sign-in and to know where the
  // service is (an agent's command has both only for itself).
  const code = args.includes("--code") ? args[args.indexOf("--code") + 1] : undefined;
  const from = args.includes("--from") ? args[args.indexOf("--from") + 1] : undefined;
  if (code && from) {
    // From the hosted MCP's auto_update: a one-time code, exchanged once — no browser step.
    // Only CoDesignFlo's own address gets the code, and only its answer is kept as where the service is.
    trustedServiceUrl(from, "--from");
    const r = await fetch(`${from.replace(/\/$/, "")}/install-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = (await r.json()) as { refresh_token?: string; service?: ServiceConfig; error?: string };
    if (!r.ok || !body.refresh_token || !body.service)
      throw new Error(body.error ?? "couldn't use the code — ask the agent for auto_update again");
    trustedServiceUrl(body.service.url, "the service address it gave");
    trustedServiceUrl(body.service.web, "the web address it gave");
    saveService(body.service);
    saveSession(body.refresh_token, { id: "", email: null });
    delete process.env.CODESIGNFLO_TOKEN;
    delete process.env.CODESIGNFLO_TICKET;
    const { user } = await signedIn();
    console.log(`this machine is signed in as ${user.email ?? user.id} (codesignflo logout to undo)`);
  } else if (!hasSession()) {
    console.log("The hook runs by itself after commits, so this machine needs its own sign-in (once):");
    delete process.env.CODESIGNFLO_TOKEN;
    delete process.env.CODESIGNFLO_TICKET;
    await login([]);
  }
  // An install that was given the service's address (development) keeps it for the hook.
  if (process.env.CODESIGNFLO_SERVICE_URL && process.env.CODESIGNFLO_SERVICE_ANON) saveService(serviceConfig());
  const r = installHook();
  console.log(r.message);
  return r.ok ? 0 : 2;
}
