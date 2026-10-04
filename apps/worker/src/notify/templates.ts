// Email texts (TASK-033e). English only at launch, like the web app; plain
// words of the human layer (ADR-022). The web app's next-intl files are not
// used here: the worker is a separate service and these texts are not UI.
// Every value from the database is escaped in the HTML part.

export type NotificationKind = "VOTE_OPENED" | "VOTE_REMINDER" | "VOTE_RESULT" | "REFUND_AVAILABLE" | "EMAIL_CONFIRM";

export interface Links {
  base: string;
  /** null for EMAIL_CONFIRM (the address is not confirmed yet, nothing to unsubscribe from). */
  unsubscribe: string | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Data = Record<string, unknown>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** "Payment 2 of 3": evidence round r (1 or 2) is followed by payment r + 1. */
const payment = (round: unknown) => `payment ${Number(round) + 1} of 3`;

function closes(voteEnd: unknown): string {
  const seconds = Number(voteEnd);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1000).toUTCString().replace("GMT", "UTC");
}

function layout(lines: string[], action: { label: string; url: string } | null, links: Links): RenderedEmail["html"] {
  const body = lines.map((l) => `<p style="margin:0 0 16px">${esc(l)}</p>`).join("");
  const button = action
    ? `<p style="margin:24px 0"><a href="${esc(action.url)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;text-decoration:none;font-weight:bold">${esc(action.label)}</a></p>`
    : "";
  const footer = links.unsubscribe
    ? `<p style="margin:32px 0 0;font-size:12px;color:#555">You get this because you donated to this campaign on CHERR.IO. <a href="${esc(links.unsubscribe)}">Stop these emails</a>.</p>`
    : "";
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111;max-width:560px;margin:0 auto;padding:24px">${body}${button}${footer}</body></html>`;
}

function textOf(lines: string[], action: { label: string; url: string } | null, links: Links): string {
  const parts = [...lines];
  if (action) parts.push(`${action.label}: ${action.url}`);
  if (links.unsubscribe) parts.push(`You get this because you donated to this campaign on CHERR.IO. Stop these emails: ${links.unsubscribe}`);
  return parts.join("\n\n") + "\n";
}

export function renderEmail(kind: NotificationKind, data: Data, links: Links): RenderedEmail {
  const title = str(data.campaignTitle);
  const campaignUrl = `${links.base}/en/campaigns/${encodeURIComponent(str(data.slug))}`;
  const donationsUrl = `${links.base}/en/account/donations`;
  let subject: string;
  let lines: string[];
  let action: { label: string; url: string } | null;

  switch (kind) {
    case "VOTE_OPENED": {
      const end = closes(data.voteEnd);
      subject = `Your vote is needed: ${title}`;
      lines = [
        `“${title}” has shown how it used the money so far and asks donors to approve ${payment(data.round)}.`,
        `Your donation gives you a vote. Look at the evidence and choose Approve or Reject${end ? ` before ${end}` : ""}.`,
      ];
      action = { label: "See the evidence and vote", url: `${campaignUrl}#evidence` };
      break;
    }
    case "VOTE_REMINDER": {
      const end = closes(data.voteEnd);
      subject = `Less than a day left to vote: ${title}`;
      lines = [
        `The vote on ${payment(data.round)} of “${title}” closes${end ? ` at ${end}` : " in less than 24 hours"}.`,
        "You have not voted yet. It takes one click.",
      ];
      action = { label: "Vote now", url: `${campaignUrl}#evidence` };
      break;
    }
    case "VOTE_RESULT": {
      const outcome = str(data.outcome);
      subject = `The vote has ended: ${title}`;
      lines =
        outcome === "REJECTED"
          ? [`Donors rejected ${payment(data.round)} of “${title}”.`, "You can now get the rest of your donation back, or it goes to the Emergency Pool if you chose that."]
          : outcome === "NEEDS_REVIEW"
            ? [`The vote on ${payment(data.round)} of “${title}” did not reach enough votes.`, "CHERR.IO is now reviewing the evidence and will decide. You will see the result on the campaign page."]
            : [`Donors approved ${payment(data.round)} of “${title}”. The payment has been released.`, "Thank you for voting."];
      action = outcome === "REJECTED" ? { label: "Open my donations", url: donationsUrl } : { label: "See the campaign", url: campaignUrl };
      break;
    }
    case "REFUND_AVAILABLE": {
      const failed = str(data.state) === "FAILED";
      subject = failed ? `“${title}” did not reach its goal` : `“${title}” was stopped`;
      lines = [
        failed
          ? `“${title}” ended without reaching 10 % of its target, so the money goes back.`
          : `Donors or CHERR.IO stopped “${title}”, so the rest of the money goes back.`,
        data.refund
          ? "You can get your money back now. It is sent to the wallet you donated from."
          : "You chose the Emergency Pool for this case: your donation can now be sent there.",
      ];
      action = { label: data.refund ? "Get my money back" : "Send to the Emergency Pool", url: donationsUrl };
      break;
    }
    case "EMAIL_CONFIRM": {
      subject = "Confirm your email for CHERR.IO";
      lines = [
        "Confirm this address to get emails about the campaigns you donate to: when a vote opens, a reminder before it closes, and when money can be returned.",
        "If you did not ask for this, ignore this email; nothing happens.",
      ];
      action = { label: "Confirm my email", url: `${links.base}/api/notifications/confirm?token=${encodeURIComponent(str(data.token))}` };
      break;
    }
  }
  return { subject, text: textOf(lines, action, links), html: layout(lines, action, links) };
}
