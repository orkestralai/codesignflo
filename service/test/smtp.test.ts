// Emails through SMTP (e.g. Gmail with an app password): the settings read from the environment, and a message
// sent to a local SMTP server with a sign-in. Needs no Supabase.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SMTPServer } from "smtp-server";
import { canEmail, sendMail } from "../mcp/notify.ts";
import { smtpFromEnv } from "../mcp/server.ts";

const PORT = 3393;
const received: { from?: string; to: string[]; user?: string; data: string }[] = [];
let server: SMTPServer;

beforeAll(async () => {
  server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    onAuth(auth, _session, done) {
      if (auth.username === "me@example.test" && auth.password === "app-password") done(null, { user: auth.username });
      else done(new Error("wrong password"));
    },
    onData(stream, session, done) {
      let data = "";
      stream.on("data", (c: Buffer) => {
        data += c.toString();
      });
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : undefined,
          to: session.envelope.rcptTo.map((r) => r.address),
          user: session.user as string | undefined,
          data,
        });
        done();
      });
    },
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("emails through SMTP", () => {
  it("reads Gmail-style settings from the environment", () => {
    expect(smtpFromEnv({})).toBeUndefined();
    expect(smtpFromEnv({ SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "a@b.c", SMTP_PASS: "x" })).toEqual({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      user: "a@b.c",
      pass: "x",
    });
    // Port and security follow each other when only one is given.
    expect(smtpFromEnv({ SMTP_HOST: "h", SMTP_PORT: "465" })).toMatchObject({ port: 465, secure: true });
    expect(smtpFromEnv({ SMTP_HOST: "h" })).toMatchObject({ port: 587, secure: false });
  });

  it("can email with SMTP or Resend, and only with a sender", () => {
    const smtp = { host: "h", port: 587, secure: false };
    expect(canEmail({ web: "w", smtp, from: "x@y.z" })).toBe(true);
    expect(canEmail({ web: "w", resendKey: "re_x", from: "x@y.z" })).toBe(true);
    expect(canEmail({ web: "w", smtp })).toBe(false);
    expect(canEmail({ web: "w", from: "x@y.z" })).toBe(false);
  });

  it("sends through the SMTP server, signed in, from the configured sender", async () => {
    await sendMail(
      { web: "w", from: "CoDesignFlo <me@example.test>", smtp: { host: "127.0.0.1", port: PORT, secure: false, user: "me@example.test", pass: "app-password" } },
      { to: ["designer@example.test"], subject: "You're invited to Shop", text: "Join it", html: "<p>Join it</p>" },
    );
    expect(received).toHaveLength(1);
    const [m] = received;
    expect(m).toMatchObject({ from: "me@example.test", to: ["designer@example.test"], user: "me@example.test" });
    expect(m!.data).toContain("Subject: You're invited to Shop");
    expect(m!.data).toContain("Join it");
  });

  it("fails loudly on a wrong password", async () => {
    await expect(
      sendMail(
        { web: "w", from: "me@example.test", smtp: { host: "127.0.0.1", port: PORT, secure: false, user: "me@example.test", pass: "nope" } },
        { to: ["x@example.test"], subject: "s", text: "t" },
      ),
    ).rejects.toThrow();
  });
});
