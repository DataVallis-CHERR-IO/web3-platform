import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@cherrio/db";
import { renderEmail, type NotificationKind } from "./templates.js";

// Sends queued notifications (TASK-033e, ADR-048). One row per transaction,
// claimed with FOR UPDATE SKIP LOCKED, so two workers never send the same row.
// The recipient is resolved now (the user may have unsubscribed or changed the
// address since the row was queued). A row older than MAX_AGE is skipped, never
// sent late. Failures back off (5, 10, 20, 40 min) and stop after MAX_ATTEMPTS.

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export const MAX_AGE_MS = 3 * 86_400_000;
export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 5 * 60_000;

export interface SendResult {
  sent: number;
  skipped: number;
  failed: number;
}

interface Row {
  id: string;
  user_id: string;
  kind: NotificationKind;
  data: Record<string, unknown>;
  attempts: number;
  created_at: Date | string;
  email_enabled: boolean | null;
  to_email: string | null;
}

const token = () => randomBytes(24).toString("base64url");

async function unsubscribeToken(tx: Parameters<Parameters<Database["transaction"]>[0]>[0], userId: string): Promise<string> {
  await tx.execute(sql`
    insert into app.notification_preferences (user_id, unsubscribe_token) values (${userId}, ${token()})
    on conflict (user_id) do nothing
  `);
  const [row] = (await tx.execute(sql`
    select unsubscribe_token from app.notification_preferences where user_id = ${userId}
  `)) as unknown as { unsubscribe_token: string }[];
  return row!.unsubscribe_token;
}

/** Sends up to `batch` due rows. */
export async function sendPending(
  db: Database,
  mailer: Mailer,
  options: { appBaseUrl: string; now?: Date; batch?: number }
): Promise<SendResult> {
  const now = options.now ?? new Date();
  const result: SendResult = { sent: 0, skipped: 0, failed: 0 };
  for (let i = 0; i < (options.batch ?? 20); i++) {
    const done = await db.transaction(async (tx) => {
      const [row] = (await tx.execute(sql`
        select n.id, n.user_id, n.kind::text as kind, n.data, n.attempts, n.created_at,
               p.email_enabled, coalesce(p.contact_email, u.email) as to_email
        from app.notifications n
        join app.users u on u.id = n.user_id
        left join app.notification_preferences p on p.user_id = n.user_id
        where n.status = 'PENDING' and n.send_after <= ${now.toISOString()}::timestamptz
        order by n.send_after, n.id
        limit 1
        for update of n skip locked
      `)) as unknown as Row[];
      if (!row) return false;

      const skip = async (reason: string) => {
        await tx.execute(sql`update app.notifications set status = 'SKIPPED', last_error = ${reason} where id = ${row.id}`);
        result.skipped++;
      };
      const confirm = row.kind === "EMAIL_CONFIRM";
      const to = confirm ? (typeof row.data.email === "string" ? row.data.email : null) : row.to_email;
      if (now.getTime() - new Date(row.created_at).getTime() > MAX_AGE_MS) { await skip("expired"); return true; }
      if (!confirm && row.email_enabled === false) { await skip("unsubscribed"); return true; }
      if (!to) { await skip("no_email"); return true; }

      const unsubscribe = confirm ? null : await unsubscribeToken(tx, row.user_id);
      const base = options.appBaseUrl;
      const email = renderEmail(row.kind, row.data, {
        base,
        unsubscribe: unsubscribe ? `${base}/en/notifications/unsubscribe?token=${encodeURIComponent(unsubscribe)}` : null,
      });
      const headers: Record<string, string> = unsubscribe
        ? {
            // RFC 8058 one-click: mail clients POST to this URL.
            "List-Unsubscribe": `<${base}/api/notifications/unsubscribe?token=${encodeURIComponent(unsubscribe)}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : {};
      try {
        await mailer.send({ to, ...email, headers });
      } catch (e) {
        const attempts = row.attempts + 1;
        const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
        const final = attempts >= MAX_ATTEMPTS;
        await tx.execute(sql`
          update app.notifications
          set attempts = ${attempts}, last_error = ${message}, status = ${final ? "FAILED" : "PENDING"}::app.notification_status,
              send_after = ${new Date(now.getTime() + BACKOFF_MS * 2 ** (attempts - 1)).toISOString()}::timestamptz
          where id = ${row.id}
        `);
        if (final) result.failed++;
        return true;
      }
      // The confirmation token is single-use and must not stay in the outbox.
      await tx.execute(sql`
        update app.notifications
        set status = 'SENT', sent_at = ${now.toISOString()}::timestamptz, attempts = ${row.attempts + 1}, last_error = null,
            data = data - 'token'
        where id = ${row.id}
      `);
      result.sent++;
      return true;
    });
    if (!done) break;
  }
  return result;
}
