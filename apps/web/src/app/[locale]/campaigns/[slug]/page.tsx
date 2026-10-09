import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Address, LedgerTable, Progress, ProofLink, StatusChip } from "@cherrio/ui";
import { Link } from "@/i18n/routing";
import { UsdcAmount, GoalAmount } from "@/components/Amount";
import { chipFor, daysLeft, percentRaised } from "@/components/campaigns/public-display";
import { getDb } from "@/lib/db";
import { listMedia } from "@/lib/campaigns/media";
import { toMediaView } from "@/lib/campaigns/media-view";
import { explorerUrls, getPublicCampaign, listCampaignDonations, listDonationThemes } from "@/lib/campaigns/public";
import { getDisplayContext } from "@/lib/fx/display";
import { fundingModeFromEnv } from "@/lib/funding/topup";
import { DonatePanel, type DonatePanelProps } from "@/components/campaigns/DonatePanel";
import { LifecyclePanel, type LifecyclePanelProps } from "@/components/campaigns/LifecyclePanel";
import { CampaignShare } from "@/components/campaigns/CampaignShare";
import { EmbedCode } from "@/components/campaigns/EmbedCode";
import { embedSnippet } from "@/lib/embed/widget";
import { RatingPanel, type RatingPanelProps } from "@/components/campaigns/RatingPanel";
import { RatingSummary } from "@/components/ratings/RatingSummary";
import { orgRatingSummaries } from "@/lib/ratings";
import { RATEABLE_CAMPAIGN_STATES } from "@cherrio/shared/ratings";
import { campaignShareUrl } from "@/lib/referrals";
import { getExpectedOrigin } from "@/lib/security/origin";
import { lifecycleJson, loadLifecycle, nowSeconds } from "@/lib/campaigns/lifecycle";
import { listPublicEvidence } from "@/lib/campaigns/evidence";
import { getChainConfig, parseAppEnv } from "@cherrio/shared";

type Params = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: "campaignPage" });
  const found = await getPublicCampaign(getDb(), slug);
  if (!found) return { title: t("metaTitle", { title: t("listTitle") }) };
  const { campaign } = found;
  const description = campaign.story.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    title: t("metaTitle", { title: campaign.title }),
    description,
    // The image is opengraph-image.tsx next to this page (cover + progress, TASK-055b).
    openGraph: { title: campaign.title, description, type: "article" },
    twitter: { card: "summary_large_image", title: campaign.title, description },
  };
}

/** "PDF", "WEBP", … for an evidence file's type. */
const fileType = (mime: string) => (mime === "application/pdf" ? "PDF" : mime.replace("image/", "").toUpperCase());
/** "12 KB" or "1.4 MB". */
const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Promise<{ donations?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const db = getDb();

  const found = await getPublicCampaign(db, slug);
  if (!found) notFound();
  const { campaign, chainAvailable } = found;

  const [t, tEv, tUi, tCause, tPool, mediaRows, ledger] = await Promise.all([
    getTranslations("campaignPage"),
    getTranslations("campaignPage.evidence"),
    getTranslations("ui"),
    getTranslations("organizations.form.causeNames"),
    getTranslations("pool"),
    listMedia(db, campaign.id),
    listCampaignDonations(db, campaign.address, { page: Number(query.donations ?? "1") }),
  ]);
  const media = toMediaView(mediaRows);
  const explorer = explorerUrls();
  const countries = new Intl.DisplayNames([locale], { type: "region" });
  const timeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

  const state = campaign.onChain?.state ?? "unknown";
  const raised = campaign.onChain?.raised ?? 0n;
  const left = state === "live" ? daysLeft(campaign.deadline) : null;
  const panelMeta: string[] = [t("percentRaised", { percent: percentRaised(raised, campaign.targetUsdc) })];
  if (campaign.onChain) panelMeta.push(t("donors", { count: campaign.onChain.donors }));
  if (state === "live") panelMeta.push(left === 0 || left === null ? t("endsToday") : t("daysLeft", { count: left }));
  else if (state !== "unknown") panelMeta.push(t("ended"));
  const causeLabel = tCause.has(campaign.cause as never) ? tCause(campaign.cause as never) : campaign.cause;
  const payout = campaign.onChain?.payoutMode ?? null;
  const org = campaign.orgName;
  // Average stars of the organisation (TASK-057b): public, raters never named.
  const ratingSummary = campaign.orgId ? (await orgRatingSummaries(db, [campaign.orgId])).get(campaign.orgId) : undefined;

  // Donate panel (TASK-011b): only while the campaign is LIVE on chain and before its deadline.
  const appEnv = parseAppEnv(process.env.APP_ENV ?? "local");
  // Share links always point at this environment's public origin (never the container address).
  const origin = getExpectedOrigin(appEnv);
  const donatable = state === "live" && campaign.onChain !== null;
  let donate: DonatePanelProps | null = null;
  if (donatable) {
    const [themes, display] = await Promise.all([listDonationThemes(db), getDisplayContext()]);
    const chain = getChainConfig(appEnv).chain;
    const remaining = campaign.targetUsdc > raised ? campaign.targetUsdc - raised : 0n;
    donate = {
      campaign: campaign.address as `0x${string}`,
      chainId: chain.id,
      networkName: chain.name,
      testnet: chain.testnet,
      remainingUsdc: remaining.toString(),
      usdPerEur18: display.rates.get("EUR")?.usdPerUnit18.toString() ?? null,
      themes: themes.map((th) => ({
        poolId: th.poolId,
        name: tPool.has(`${th.slug}.name` as never) ? tPool(`${th.slug}.name` as never) : th.slug,
      })),
      explorerTx: explorer ? explorer.tx : null,
      appEnv,
      funding: fundingModeFromEnv(chain.testnet),
    };
  }

  // Milestone evidence on chain (TASK-033c, ADR-047): public summary only.
  const evidence = campaign.onChain !== null ? await listPublicEvidence(db, campaign.id, campaign.address) : [];

  // Lifecycle panel (TASK-033b): after LIVE — finish, payout, vote, refunds.
  let lifecycle: LifecyclePanelProps | null = null;
  let rating: RatingPanelProps | null = null;
  if (!donatable && campaign.onChain !== null) {
    const lc = await loadLifecycle(db, campaign.address);
    // Ratings (ADR-058): finished campaigns of organisations; the panel asks who may rate.
    if (lc && org && (RATEABLE_CAMPAIGN_STATES as readonly string[]).includes(lc.state)) {
      rating = { campaignId: campaign.id, chainId: getChainConfig(appEnv).chain.id, appEnv };
    }
    if (lc && (lc.state !== "LIVE" || nowSeconds() >= lc.deadline)) {
      lifecycle = {
        campaign: campaign.address as `0x${string}`,
        chainId: getChainConfig(appEnv).chain.id,
        explorerTx: explorer ? explorer.tx : null,
        appEnv,
        initial: lifecycleJson(lc, nowSeconds()),
        hasEvidence: evidence.length > 0,
      };
    }
  }

  return (
    <article className="ch-campaign">
      <div className="ch-campaign-top">
        <div className="ch-campaign-main">
          <div className="ch-campaign-photo">
            {campaign.coverUrl && <img src={campaign.coverUrl} alt={t("coverAlt", { title: campaign.title })} />}
          </div>
          <div className="ch-campaign-meta">
            <StatusChip status={chipFor(state)}>{t(`state.${state}`)}</StatusChip>
            <span className="inline-flex items-center gap-2">
              {campaign.orgVerified && (
                <span className="ch-verified" role="img" aria-label={tUi("verified")}>
                  <span aria-hidden="true">✓</span>
                </span>
              )}
              {org}
              {ratingSummary && <RatingSummary summary={ratingSummary} locale={locale} />}
            </span>
            <span>{causeLabel}</span>
            <span>{countries.of(campaign.country) ?? campaign.country}</span>
          </div>
          <h1 className="ch-campaign-title">{campaign.title}</h1>
          {campaign.isDemo && <p className="ch-demo-note">{t("demoNote")}</p>}
        </div>

        <aside className="ch-campaign-panel" aria-label={t("panelLabel")}>
          <span className="ch-campaign-key">
            <UsdcAmount usdc={raised} maxDecimals={0} />
          </span>
          <span className="ch-campaign-panel-meta">
            {t.rich("raisedOf", { target: () => <GoalAmount goal={campaign.goal} /> })}
          </span>
          <Progress
            raised={{ usdc: raised }}
            target={{ usdc: campaign.targetUsdc }}
            currency="USDC"
            showFigures={false}
            barLabel={t("barLabel", { percent: percentRaised(raised, campaign.targetUsdc) })}
            meta={panelMeta.join(" · ")}
            successLineLabel={t("successLine")}
            willSucceedLabel={t("willSucceed")}
          />
          {!chainAvailable && (
            <p className="ch-notice m-0" role="status">
              {t("chainUnavailable")}
            </p>
          )}
          {donate && <DonatePanel {...donate} />}
          {lifecycle && <LifecyclePanel {...lifecycle} />}
          {rating && <RatingPanel {...rating} />}
          <ProofLink href="#proof">{t("seeDonations")}</ProofLink>
          <CampaignShare url={campaignShareUrl(origin, locale, campaign.slug)} title={campaign.title} />
          <EmbedCode code={embedSnippet(origin, campaign.slug)} />
        </aside>

        <section className="ch-campaign-section" aria-labelledby="story-heading">
          <span className="ch-eyebrow" id="story-heading">
            {t("storyEyebrow")}
          </span>
          <p className="ch-campaign-story">{campaign.story}</p>

          {media.images.length > 0 && (
            <>
              <h2 className="heading-2 m-0">{t("galleryTitle")}</h2>
              <div className="ch-campaign-gallery">
                {media.images.map((img, i) => (
                  <img key={img.id} src={img.url} alt={t("galleryAlt", { n: i + 1, title: campaign.title })} loading="lazy" />
                ))}
              </div>
            </>
          )}

          {media.videos.length > 0 && (
            <>
              <h2 className="heading-2 m-0">{t("videosTitle")}</h2>
              <div className="ch-campaign-videos">
                {media.videos.map((v, i) => (
                  <div key={v.id} className="ch-campaign-video">
                    <iframe
                      src={v.embedUrl}
                      title={t("videoTitle", { n: i + 1, title: campaign.title })}
                      loading="lazy"
                      allow="encrypted-media; picture-in-picture; fullscreen"
                      referrerPolicy="strict-origin-when-cross-origin"
                      allowFullScreen
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {media.documents.length > 0 && (
            <>
              <h2 className="heading-2 m-0">{t("documentsTitle")}</h2>
              <ul className="ch-campaign-docs">
                {media.documents.map((d) => (
                  <li key={d.id}>
                    <a className="ch-proof" href={d.url} target="_blank" rel="noopener noreferrer">
                      {d.label}
                    </a>{" "}
                    <span className="text-sm text-[var(--ink-muted)]">{t("documentSize", { size: d.sizeKb })}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>


      <section className="ch-campaign-section ch-band-tint" aria-labelledby="protection-heading">
        <span className="ch-eyebrow">{t("protection.eyebrow")}</span>
        <h2 className="ch-section-heading" id="protection-heading">
          {t("protection.title")}
        </h2>
        <ul className="ch-campaign-rules">
          <li>
            <strong>{t("protection.escrowTitle")}</strong>
            {t("protection.escrowBody", { org })}
          </li>
          <li>
            <strong>{t("protection.thresholdTitle")}</strong>
            {t("protection.thresholdBody")}
          </li>
          <li>
            {payout === "SINGLE" ? (
              <>
                <strong>{t("protection.singleTitle")}</strong>
                {t("protection.singleBody", { org })}
              </>
            ) : payout === "MILESTONES" ? (
              <>
                <strong>{t("protection.milestonesTitle")}</strong>
                {t("protection.milestonesBody", { org })}
              </>
            ) : (
              <>
                <strong>{t("protection.pendingTitle")}</strong>
                {t("protection.pendingBody", { org })}
              </>
            )}
          </li>
        </ul>
      </section>

      {evidence.length > 0 && (
        <section id="evidence" className="ch-campaign-section" aria-labelledby="evidence-heading">
          <span className="ch-eyebrow">{tEv("eyebrow")}</span>
          <h2 className="ch-section-heading" id="evidence-heading">{tEv("title")}</h2>
          <p className="m-0">{tEv("intro")}</p>
          {evidence.map((b) => (
            <div key={b.id} className="flex flex-col gap-2">
              <h3 className="heading-2 m-0">{tEv("round", { payment: b.round + 2 })}</h3>
              {b.note && <p className="m-0 whitespace-pre-line">{b.note}</p>}
              <h4 className="ch-label m-0">{tEv("files")}</h4>
              <ul className="ch-campaign-docs">
                {b.files.map((f) => (
                  <li key={f.id}>
                    {f.url ? (
                      <>
                        <a className="ch-proof" href={f.url} target="_blank" rel="noopener noreferrer">{tEv("open")}</a>{" "}
                        <span className="text-sm">{tEv("publicFile", { type: fileType(f.mimeType), size: fileSize(f.sizeBytes) })}</span>
                      </>
                    ) : (
                      <span className="text-sm">{tEv("privateFile", { type: fileType(f.mimeType), size: fileSize(f.sizeBytes) })}</span>
                    )}{" "}
                    <span className="ch-mono text-sm break-all">SHA-256 {f.sha256.slice(0, 16)}…</span>
                  </li>
                ))}
              </ul>
              {b.files.some((f) => !f.url) && <p className="m-0 text-sm">{tEv("privateHint")}</p>}
              <p className="m-0 text-sm">
                {tEv("fingerprint")}: <span className="ch-mono break-all">{b.bundleHash}</span>
              </p>
              <p className="m-0 text-sm">
                <ProofLink href={`/api/evidence/${b.id}/manifest`}>{tEv("manifest")}</ProofLink> {tEv("manifestHint")}
              </p>
            </div>
          ))}
        </section>
      )}

      <section id="proof" className="ch-campaign-section pb-16" aria-labelledby="proof-heading">
        <span className="ch-eyebrow">{t("proof.eyebrow")}</span>
        <h2 className="ch-section-heading" id="proof-heading">
          {t("proof.title")}
        </h2>
        <p className="m-0">{t("proof.intro")}</p>
        <div className="ch-campaign-proof-meta">
          <span>{t("proof.contract")}</span>
          <Address address={campaign.address} copyLabel={tUi("address.copy")} copiedLabel={tUi("address.copied")} />
          {explorer && (
            <a className="ch-proof" href={`${explorer.address}${campaign.address}`} target="_blank" rel="noopener noreferrer">
              {t("proof.viewContract")}
              <span aria-hidden="true"> ↗</span>
            </a>
          )}
        </div>

        {ledger === null ? (
          <p className="ch-notice m-0" role="status">
            {t("chainUnavailable")}
          </p>
        ) : ledger.donations.length === 0 ? (
          <p className="m-0">{t("proof.none")}</p>
        ) : (
          <>
            <LedgerTable
              rows={ledger.donations.map((d) => ({
                time: timeFormat.format(new Date(Number(d.blockTime) * 1000)),
                from: d.donor,
                fromDisplay:
                  d.donorName.kind === "named"
                    ? d.donorName.name
                    : d.donorName.kind === "anonymous"
                      ? t("proof.anonymous")
                      : undefined,
                label: t("proof.type"),
                amount: d.amount,
                tx: d.txHash,
              }))}
              explorerBase={explorer ? explorer.tx : null}
              caption={`${t("proof.count", { count: ledger.total })} · ${t("proof.timeZone")}`}
              colTime={tUi("ledger.time")}
              colFrom={tUi("ledger.from")}
              colType={tUi("ledger.type")}
              colAmount={tUi("ledger.amount")}
              colTx={tUi("ledger.tx")}
              txAriaLabel={(tx) => t("proof.txAria", { tx })}
              regionLabel={t("proof.title")}
            />
            {ledger.pageCount > 1 && (
              <nav className="ch-pager" aria-label={t("pagination")}>
                {ledger.page > 1 && (
                  <Link
                    href={{ pathname: `/campaigns/${campaign.slug}`, query: { donations: ledger.page - 1 }, hash: "proof" }}
                    className="ch-proof"
                  >
                    {t("pagePrev")}
                  </Link>
                )}
                <span>{t("pageOf", { page: ledger.page, count: ledger.pageCount })}</span>
                {ledger.page < ledger.pageCount && (
                  <Link
                    href={{ pathname: `/campaigns/${campaign.slug}`, query: { donations: ledger.page + 1 }, hash: "proof" }}
                    className="ch-proof"
                  >
                    {t("pageNext")}
                  </Link>
                )}
              </nav>
            )}
          </>
        )}
      </section>
      {donate && (
        <a className="ch-donate-bar" href="#donate">
          {t("donate.bar")}
        </a>
      )}
    </article>
  );
}
