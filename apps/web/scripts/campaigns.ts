/**
 * Campaign maintenance commands, bundled into the image as apps/web/dist/campaigns.mjs.
 *
 *   node apps/web/dist/campaigns.mjs reset-after-redeploy            (shows what would change)
 *   node apps/web/dist/campaigns.mjs reset-after-redeploy --apply    (changes it)
 *
 * After the test network's contracts are deployed again, campaigns published
 * to the old factory go back to APPROVED so they can be published again.
 * Refused on prod. Prints counts and campaign titles only.
 */
import { createDb } from "@cherrio/db";
import { publishDeployment } from "../src/lib/campaigns/publish";
import { RedeployResetRefusedError, resetCampaignsFromEarlierDeployment } from "../src/lib/campaigns/redeploy";

const [command, ...flags] = process.argv.slice(2);

async function main(): Promise<number> {
  if (command === "reset-after-redeploy" && flags.every((flag) => flag === "--apply")) {
    const apply = flags.length > 0;
    const appEnv = process.env.APP_ENV;
    const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
    if (!appEnv || !url) {
      console.error("APP_ENV and DATABASE_URL (or DATABASE_URL_DIRECT) must be set.");
      return 1;
    }
    if (appEnv === "prod") {
      console.error("Refused: never on prod — mainnet contracts are not replaced.");
      return 1;
    }
    const db = createDb(url, { max: 1 });
    try {
      const deployment = publishDeployment(process.env);
      const { found, reset } = await resetCampaignsFromEarlierDeployment(db, appEnv, deployment, { apply });
      console.log(`Current CampaignFactory: ${deployment?.factory}`);
      for (const campaign of found) console.log(`  ${campaign.isDemo ? "[demo] " : ""}${campaign.title}`);
      console.log(
        apply
          ? `campaigns:reset-after-redeploy: ${reset} of ${found.length} campaign(s) from an earlier deployment are APPROVED again.`
          : `campaigns:reset-after-redeploy (dry run — nothing changed): ${found.length} campaign(s) from an earlier deployment. Run again with --apply.`
      );
      return 0;
    } finally {
      await db.$client.end();
    }
  }
  console.error("Usage: campaigns reset-after-redeploy [--apply]");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const detail =
      error instanceof RedeployResetRefusedError
        ? `refused: ${error.message}`
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : "unknown error";
    console.error(`campaigns ${command ?? ""} failed — ${detail}`);
    process.exit(1);
  }
);
