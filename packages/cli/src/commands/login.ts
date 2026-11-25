// codesignflo login — signs in to the CoDesignFlo service without typing a password here: shows a code
// to type on the sign-in page it opens (Figma or GitHub), waits for the approval, keeps the session in ~/.codesignflo.
import { spawn } from "node:child_process";
import { anonClient, forgetSession, hasSession, saveSession, serviceConfig, signedIn } from "../service/client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function login(args: string[]): Promise<number> {
  const cfg = serviceConfig();
  const client = anonClient(cfg);
  const { data, error } = await client.rpc("start_login", { p_client: "cli" });
  if (error) throw new Error(`couldn't start sign-in: ${error.message}`);
  const { device_code, user_code } = (data as { device_code: string; user_code: string }[])[0]!;
  const shown = `${user_code.slice(0, 4)}-${user_code.slice(4)}`;
  // The code isn't in the link (?code alone opens the code box): the developer types it on the page, so a link someone else sent can't sign them in.
  const url = `${cfg.web}/?code`;
  console.log(`Sign in at ${url}\nand type this code on the page: ${shown}`);
  if (!args.includes("--no-browser"))
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  for (let waited = 0; waited < 600_000; waited += 2000) {
    await sleep(2000);
    const r = await client.rpc("poll_login", { p_device_code: device_code });
    if (r.error) throw new Error(r.error.message);
    if (r.data) {
      const s = await client.auth.refreshSession({ refresh_token: r.data as string });
      if (s.error || !s.data.session || !s.data.user) throw new Error("sign-in failed — try again");
      saveSession(s.data.session.refresh_token, { id: s.data.user.id, email: s.data.user.email ?? null });
      console.log(`signed in as ${s.data.user.email ?? s.data.user.id}`);
      return 0;
    }
  }
  throw new Error("sign-in timed out — run codesignflo login again");
}

export async function whoami(): Promise<number> {
  const { user } = await signedIn();
  console.log(user.email ?? user.id);
  return 0;
}

/**
 * codesignflo logout [--everywhere] — revokes this machine's sign-in (the one the git hook uses) and forgets
 * it; --everywhere revokes every session of the account (coding agents, plugins, other machines).
 */
export async function logout(args: string[]): Promise<number> {
  if (!hasSession()) {
    console.log("not signed in on this machine");
    return 0;
  }
  const everywhere = args.includes("--everywhere");
  try {
    const { client } = await signedIn();
    const { error } = await client.auth.signOut({ scope: everywhere ? "global" : "local" });
    if (error) throw error;
  } catch (e) {
    // An expired sign-in is already unusable: just forget it.
    if (!/expired/.test((e as Error).message)) throw e;
  }
  forgetSession();
  console.log(
    everywhere ? "signed out everywhere: every session of this account is revoked" : "signed out on this machine (its sign-in is revoked)",
  );
  return 0;
}
