import { getTranslations } from "next-intl/server";
import { CampaignCard, Progress } from "@cherrio/ui";
import { UsdcAmount, GoalAmount } from "@/components/Amount";
import { chipFor, daysLeft, percentRaised } from "@/components/campaigns/public-display";
import type { PublicCampaignSummary } from "@/lib/campaigns/public";

// One published campaign as a card: used by the campaign list (TASK-011a) and
// the landing page (TASK-037), so both show the same figures.

export async function PublicCampaignCard({
  campaign: c,
  locale,
}: {
  campaign: PublicCampaignSummary;
  locale: string;
}) {
  const t = await getTranslations("campaignPage");
  const tUi = await getTranslations("ui");
  const state = c.onChain?.state ?? "unknown";
  const raised = c.onChain?.raised ?? 0n;
  const left = state === "live" ? daysLeft(c.deadline) : null;
  const meta: string[] = [];
  if (c.onChain) meta.push(t("donors", { count: c.onChain.donors }));
  if (state === "live") meta.push(left === 0 || left === null ? t("endsToday") : t("daysLeft", { count: left }));
  return (
    <CampaignCard
      href={`/${locale}/campaigns/${c.slug}`}
      title={c.title}
      org={c.orgName}
      verified={c.orgVerified}
      verifiedLabel={tUi("verified")}
      image={c.coverUrl ?? undefined}
      imageAlt={t("coverAlt", { title: c.title })}
      status={chipFor(state)}
      statusLabel={t(`state.${state}`)}
      tag={c.isDemo ? t("demoTag") : undefined}
      raised={{ usdc: raised }}
      target={{ usdc: c.targetUsdc }}
    >
      <Progress
        raised={{ usdc: raised }}
        target={{ usdc: c.targetUsdc }}
        currency="USDC"
        raisedLabel={<UsdcAmount usdc={raised} maxDecimals={0} />}
        targetLabel={<GoalAmount goal={c.goal} />}
        barLabel={t("barLabel", { percent: percentRaised(raised, c.targetUsdc) })}
        meta={meta.length > 0 ? meta.join(" · ") : undefined}
        successLineLabel={t("successLine")}
        willSucceedLabel={t("willSucceed")}
      />
    </CampaignCard>
  );
}
