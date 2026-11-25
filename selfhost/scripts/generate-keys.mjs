#!/usr/bin/env node
// Fills the box's secrets into selfhost/.env (made from .env.example when missing): every secret that is empty
// gets a fresh random value, and ANON_KEY and SERVICE_ROLE_KEY are signed with JWT_SECRET. Secrets already set are
// kept, so running it again changes nothing; --force replaces them all (a new box only: it signs everyone out and
// the database's password would no longer match).
//
//   node scripts/generate-keys.mjs [--force] [path/to/.env]
import { createHmac, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const force = args.includes("--force");
const here = dirname(dirname(fileURLToPath(import.meta.url)));
const file = args.find((a) => !a.startsWith("--")) ?? join(here, ".env");
if (!existsSync(file)) {
  copyFileSync(join(here, ".env.example"), file);
  console.log(`made ${file} from .env.example`);
}

let text = readFileSync(file, "utf8");
const get = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
const set = (k, v) => {
  text = new RegExp(`^${k}=`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`) : `${text.replace(/\n?$/, "\n")}${k}=${v}\n`;
};

const hex = (bytes) => randomBytes(bytes).toString("hex");
const b64url = (b) => Buffer.from(b).toString("base64url");
/** An HS256 token as Supabase's keys are: the role, issuer "supabase", valid ten years. */
function sign(secret, role) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + 10 * 365 * 24 * 3600 }));
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}

const made = [];
const fill = (k, make) => {
  if (force || !get(k)) {
    set(k, make());
    made.push(k);
  }
};
fill("POSTGRES_PASSWORD", () => hex(24));
fill("JWT_SECRET", () => hex(32));
fill("NOTIFY_SECRET", () => hex(32));
fill("SECRET_KEY_BASE", () => hex(48));
fill("REALTIME_DB_ENC_KEY", () => hex(8));
// The first account's code (whoever reaches a fresh box first doesn't become its admin): XXXX-XXXX, no look-alikes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
fill("SETUP_CODE", () => {
  const c = [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
});
// The keys follow the secret: re-signed whenever it was just made (or they're missing).
const secret = get("JWT_SECRET");
const fresh = made.includes("JWT_SECRET");
if (fresh || !get("ANON_KEY")) {
  set("ANON_KEY", sign(secret, "anon"));
  made.push("ANON_KEY");
}
if (fresh || !get("SERVICE_ROLE_KEY")) {
  set("SERVICE_ROLE_KEY", sign(secret, "service_role"));
  made.push("SERVICE_ROLE_KEY");
}

writeFileSync(file, text, { mode: 0o600 });
console.log(made.length ? `wrote ${made.join(", ")} into ${file}` : `${file} already has every secret (--force replaces them)`);
console.log(`setup code for the box's first account (its admin): ${get("SETUP_CODE")}`);
if (get("SMTP_HOST") && get("EMAIL_AUTOCONFIRM") !== "false")
  console.log("note: SMTP is set but EMAIL_AUTOCONFIRM isn't false: email addresses aren't confirmed, so invitations need sign-up codes and ALLOWED_DOMAINS is ignored");
