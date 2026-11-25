import { and, eq, isNotNull } from "drizzle-orm";
import type { Hex } from "viem";
import { auditLog, campaigns, type Database } from "@cherrio/db";
import { predictCampaignAddress } from "@cherrio/shared";
import type { PublishDeployment } from "./publish";

// After the test network's contracts are deployed again (new CampaignFactory,
// new addresses), campaigns published to the old factory still say DEPLOYED
// and point at a clone the indexer no longer follows. This puts them back to
// APPROVED so an admin can publish them on the new factory ("Publish all" for
// demo campaigns, the admin campaign page for the others).
//
// A campaign is "from an earlier deployment" when its stored address is not
// the address the CURRENT factory gives its offchainId — a pure check, so it
// does not depend on how far the indexer has got. Never on prod: contracts
// there are not replaced, and old campaigns finish on their own code (ADR-009).

export interface EarlierCampaign {
  id: string;
  title: string;
  isDemo: boolean;
  previousAddress: string;
}

export class RedeployResetRefusedError extends Error {}

export async function findCampaignsFromEarlierDeployment(
  db: Database,
  deployment: PublishDeployment
): Promise<EarlierCampaign[]> {
  const rows = await db
    .select({
      id: campaigns.id,
      title: campaigns.title,
      isDemo: campaigns.isDemo,
      offchainId: campaigns.offchainId,
      onchainAddress: campaigns.onchainAddress,
    })
    .from(campaigns)
    .where(and(eq(campaigns.status, "DEPLOYED"), isNotNull(campaigns.onchainAddress)));

  return rows.flatMap((row) => {
    const address = row.onchainAddress!.toLowerCase();
    // A deployed campaign without an offchainId cannot be on the current factory either.
    const current = row.offchainId
      ? predictCampaignAddress(deployment.factory, deployment.implementation, `0x${row.offchainId.toString("hex")}` as Hex).toLowerCase()
      : null;
    return current === address ? [] : [{ id: row.id, title: row.title, isDemo: row.isDemo, previousAddress: address }];
  });
}

export async function resetCampaignsFromEarlierDeployment(
  db: Database,
  appEnv: string,
  deployment: PublishDeployment | null,
  options: { apply: boolean; now?: Date }
): Promise<{ found: EarlierCampaign[]; reset: number }> {
  if (appEnv === "prod") throw new RedeployResetRefusedError("never on prod: mainnet contracts are not replaced");
  if (!deployment) throw new RedeployResetRefusedError(`no contracts are configured for APP_ENV=${appEnv}`);

  const found = await findCampaignsFromEarlierDeployment(db, deployment);
  if (!options.apply || found.length === 0) return { found, reset: 0 };

  const now = options.now ?? new Date();
  const reset = await db.transaction(async (tx) => {
    let count = 0;
    for (const campaign of found) {
      // Only the row exactly as it was read: a campaign changed meanwhile is left alone.
      const updated = await tx
        .update(campaigns)
        .set({ status: "APPROVED", onchainAddress: null, publishTxHash: null, deadline: null, deployedAt: null, updatedAt: now })
        .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "DEPLOYED"), eq(campaigns.onchainAddress, campaign.previousAddress)))
        .returning({ id: campaigns.id });
      if (updated.length === 0) continue;
      await tx.insert(auditLog).values({
        actorUserId: null,
        action: "campaign.reset_after_redeploy",
        entityType: "campaign",
        entityId: campaign.id,
        data: { previousAddress: campaign.previousAddress, factory: deployment.factory.toLowerCase() },
      });
      count += 1;
    }
    return count;
  });
  return { found, reset };
}
