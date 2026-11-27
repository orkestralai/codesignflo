// A new plugin is out: the designers whose plugin is behind hear about it by email, once per version (the plugin's
// panel says so too, while it's open). The plugin isn't on Figma Community, which would update it by itself. Sent by
// the daily cron, to people who opened the plugin in the last 90 days and haven't turned project emails off.
import type { SupabaseClient } from "@supabase/supabase-js";
import { type NotifyConfig, sendMail } from "./notify.ts";

/** "0.5.10" is after "0.5.9": compared number by number; no version (an old plugin didn't say) is before any. */
export function versionBelow(version: string | null | undefined, than: string): boolean {
  if (!version || !/^\d+(\.\d+)*$/.test(version)) return true;
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

type Recipient = { user_id: string; email: string; version: string | null; too_old: boolean };

/** Emails about plugin `latest` to whoever's behind; each is recorded first, so a second run doesn't send it again. */
export async function pluginUpdateEmails(
  db: SupabaseClient,
  cfg: NotifyConfig,
  latest: string,
  download: string,
  minimum: string,
): Promise<{ sent: number; failed: number }> {
  if (!cfg.smtp && !cfg.resendKey) return { sent: 0, failed: 0 };
  const { data, error } = await db.rpc("plugin_update_recipients", { p_latest: latest, p_limit: 100 });
  if (error) throw new Error(`couldn't list who to tell about plugin ${latest}: ${error.message}`);
  let sent = 0;
  let failed = 0;
  for (const r of (data ?? []) as Recipient[]) {
    // Claimed first: two crons at once don't both send it.
    const { error: taken } = await db.from("plugin_update_notices").insert({ user_id: r.user_id, version: latest });
    if (taken) continue;
    const blocked = r.too_old
      ? `Your plugin is older than ${minimum}, the oldest that can apply Live updates: until you update, the developers' updates to Live wait.\n\n`
      : "";
    try {
      await sendMail(cfg, {
        to: [r.email],
        subject: `CoDesignFlo plugin ${latest} is out`,
        text: `A new version of the CoDesignFlo Figma plugin is out: ${latest}${r.version ? ` (you have ${r.version})` : ""}.

${blocked}To update:
1. Download ${download}
2. Unzip it into the folder you imported the plugin from, replacing its files.
3. In Figma, close the CoDesignFlo plugin and open it again. Its panel shows the version at the bottom.

You get this because you use CoDesignFlo in Figma. To stop CoDesignFlo's emails, turn off "Email me when there's something for me" in a project's settings at ${cfg.web}.`,
      });
      sent++;
    } catch (e) {
      // Given back, so the next run tries again.
      await db.from("plugin_update_notices").delete().eq("user_id", r.user_id).eq("version", latest);
      console.error(`plugin ${latest} email:`, e);
      failed++;
    }
  }
  return { sent, failed };
}
