import type { Database } from "@cherrio/db";
import { awardPoints, pointsAwarded, type PointsCursor } from "./points.js";
import { enqueueLifecycle, type EnqueueResult } from "./notify/enqueue.js";
import { sendPending, type Mailer, type SendResult } from "./notify/send.js";

// One worker tick (TASK-033e, ADR-048): points, then the email queue, then
// sending. A missing chain.* view (an indexer deploy in progress) skips the
// chain steps for this tick; sending still runs.

export interface TickResult {
  points: number | null;
  queued: EnqueueResult | null;
  sent: SendResult | null;
}

const isMissingRelation = (e: unknown) => {
  const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return code === "42P01" || code === "3F000";
};

async function chainStep<T>(step: () => Promise<T>): Promise<T | null> {
  try {
    return await step();
  } catch (e) {
    if (isMissingRelation(e)) return null;
    throw e;
  }
}

export async function tick(
  db: Database,
  options: { mailer: Mailer | null; appBaseUrl: string; now?: Date; pointsCursor?: PointsCursor }
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  const points = await chainStep(async () => pointsAwarded(await awardPoints(db, options.pointsCursor, now.getTime())));
  const queued = await chainStep(() => enqueueLifecycle(db, seconds));
  const sent = options.mailer ? await sendPending(db, options.mailer, { appBaseUrl: options.appBaseUrl, now }) : null;
  return { points, queued, sent };
}
