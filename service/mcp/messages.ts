// The one-line message for each fact the notifications tell people about (emails, Slack, the web app's activity).
// Kept apart from notify.ts, which sends them: the web app shows these lines without the mail code.

/** A fact from the notifications outbox, as much of it as its message needs. */
export type Fact = { kind: string; component: string; by: string; body: Record<string, unknown> };

const quote = (v: unknown) => (typeof v === "string" && v.trim() ? ` — “${v.trim().slice(0, 300)}”` : "");
const pretty = (component: string) => component.replace(/^(components|pages)\./, "").replace(/[-_.]/g, " ");

/** The one-line message for a fact. */
export function message(n: Fact): string {
  const c = pretty(n.component);
  const b = n.body;
  switch (n.kind) {
    case "ready":
      return `${n.by} sent ${c} to development${quote(b.note)}`;
    case "designed_new":
      return `${n.by} sent a new design: ${c}${quote(b.note)}`;
    case "review_answered":
      return `${n.by} answered the questions on ${c}${quote(b.answer)}`;
    case "sent_back":
      return `${n.by} has a question about ${c}${quote(b.question)}`;
    case "dev_reviewed":
      return `${n.by} reviewed ${c} and has questions${quote(b.question)}`;
    case "building":
      return `${n.by} started building ${c}`;
    case "closed":
      return b.how === "accepted" ? `${c}: the code's version was accepted` : `${c} is done in code`;
    case "live_applied":
      return `Live was updated in Figma from ${n.by || "code"} @${String(b.commit ?? "").slice(0, 7)}`;
    case "invited":
      return `${n.by} invited ${String(b.email ?? "someone")} as ${String(b.role ?? "a member")}`;
    case "live_failed": {
      const last =
        String(b.log ?? "")
          .trim()
          .split("\n")
          .pop() ?? "";
      return `Live couldn't be updated from @${String(b.commit ?? "").slice(0, 7)}${last ? `: ${last.slice(0, 300)}` : ""}`;
    }
    default:
      return `${c}: ${n.kind}`;
  }
}
