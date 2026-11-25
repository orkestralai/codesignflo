// codesignflo invite / people — who is in this app's project (cloud projects). Usually the designer invites
// the developer from the plugin; this is the same from the developer's side (CLI or the MCP's `invite`).
import { readConfig } from "../project.js";
import { signedIn } from "../service/client.js";

function cloudProject(): string {
  const c = readConfig();
  if (!c?.cloud) throw new Error("this app isn't connected to the CoDesignFlo service — run: codesignflo init --cloud");
  return c.projectId;
}

type Person = { email: string | null; role: string; pending: boolean; email_status?: string | null; email_error?: string | null };

/** How a pending invitation's email went. */
export const mailNote = (m: Person) =>
  !m.pending
    ? ""
    : m.email_status === "sent"
      ? " — invitation email sent"
      : m.email_status === "failed"
        ? ` — invitation email not sent: ${m.email_error ?? "unknown error"}`
        : m.email_status === "queued"
          ? " — invitation email on its way"
          : " — no invitation email sent";

export async function invite(args: string[]): Promise<number> {
  const email = args.find((a) => !a.startsWith("--"));
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error("usage: codesignflo invite <email> [--designer | --developer | --admin] | invite <email> --resend");
  const { client } = await signedIn();
  if (args.includes("--resend")) {
    const { error } = await client.rpc("resend_invitation", { p_project: cloudProject(), p_email: email });
    if (error) throw new Error(error.message);
    console.log(`invitation email sent again to ${email}`);
    return 0;
  }
  const role = args.includes("--admin") ? "admin" : args.includes("--developer") ? "developer" : "designer";
  const { data, error } = await client.rpc("invite", { p_project: cloudProject(), p_email: email, p_role: role });
  if (error) throw new Error(error.message);
  if (data === "role_changed") {
    console.log(`${email} is now ${role === "admin" ? "an admin" : `a ${role}`} in the project`);
    return 0;
  }
  if (data === "member") {
    console.log(`${email} is in the project already (only an admin changes their role, by inviting them again with the new one)`);
    return 0;
  }
  // A self-hosted box that doesn't prove emails: the invitation's sign-up code, for the inviter to pass on.
  const code =
    data === "invited"
      ? ((await client.rpc("invitation_code", { p_project: cloudProject(), p_email: email })).data as string | null)
      : null;
  if (code) {
    console.log(
      `invited ${email} as ${role} — give them this sign-up code: ${code} (they create their account with that email and the code)`,
    );
    return 0;
  }
  console.log(
    data === "added"
      ? `${email} is now in the project (${role}) — they got an email about it`
      : `invited ${email} as ${role} — an email tells them how to join (they join when they sign in with that email)`,
  );
  return 0;
}

export async function people(): Promise<number> {
  const { client } = await signedIn();
  const { data, error } = await client.rpc("project_people", { p_project: cloudProject() });
  if (error) throw new Error(error.message);
  for (const m of data as Person[])
    console.log(`${(m.email ?? "(no email)").padEnd(32)} ${m.role}${m.pending ? " (invited)" : ""}${mailNote(m)}`);
  return 0;
}
