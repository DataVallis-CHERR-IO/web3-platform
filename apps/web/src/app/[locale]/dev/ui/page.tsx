/**
 * /dev/ui — component gallery.
 * Guarded by APP_ENV: only renders when "local" or "dev".
 * Returns 404 for "uat" and "prod".
 */
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { useTranslations } from "next-intl";
import {
  Button,
  StatusChip,
  Field,
  Progress,
  ProofLink,
  CampaignCard,
  MilestoneTrack,
  VoteMeter,
  TrustScore,
  LedgerTable,
  Address,
} from "@cherrio/ui";

export default async function DevUiPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const appEnv = process.env.APP_ENV ?? "prod";
  if (appEnv !== "local" && appEnv !== "dev") notFound();

  const { locale } = await params;
  setRequestLocale(locale);
  return <Gallery />;
}

function Gallery() {
  const tStatus = useTranslations("ui.status");
  const tMilestone = useTranslations("ui.milestone");
  const tVote = useTranslations("ui.vote");
  const tProgress = useTranslations("ui.progress");
  const tLedger = useTranslations("ui.ledger");
  const tAddr = useTranslations("ui.address");
  const tTrust = useTranslations("ui.trust");

  return (
    <div className="ch-stage-col" style={{ maxWidth: "100%", padding: "var(--space-6)" }}>
      <h1 className="ch-label" style={{ fontSize: 24 }}>Component Gallery — /dev/ui</h1>

      {/* Button */}
      <section>
        <h2 className="ch-label">Button</h2>
        <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="primary" size="lg">Primary LG</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      {/* StatusChip */}
      <section>
        <h2 className="ch-label">StatusChip</h2>
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          {(["live","voting","in-review","verified","succeeded","pending","imported","needs-review","frozen","rejected"] as const).map((s) => (
            <StatusChip key={s} status={s}>{tStatus(s)}</StatusChip>
          ))}
        </div>
      </section>

      {/* Field */}
      <section>
        <h2 className="ch-label">Field</h2>
        <div style={{ display: "grid", gap: "var(--space-4)", maxWidth: 480, marginTop: "var(--space-3)" }}>
          <Field label="Donation amount" suffix="EUR" mono placeholder="100" />
          <Field label="Email" type="email" hint="We never share your email." />
          <Field label="Amount" error="Must be at least €10" mono placeholder="5" />
        </div>
      </section>

      {/* Progress */}
      <section>
        <h2 className="ch-label">Progress</h2>
        <div style={{ maxWidth: 480, marginTop: "var(--space-3)" }}>
          <Progress
            raised={{ eurCents: 3_248_000n }}
            target={{ eurCents: 20_000_000n }}
            meta="312 donors · 9 days left"
            successLineLabel={tProgress("successLine")}
            willSucceedLabel={tProgress("willSucceed")}
          />
        </div>
      </section>

      {/* ProofLink */}
      <section>
        <h2 className="ch-label">ProofLink</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <ProofLink href="#proof">Verified on blockchain</ProofLink>
          &nbsp;&nbsp;
          <ProofLink href="https://amoy.polygonscan.com" external>View on Polygonscan</ProofLink>
        </div>
      </section>

      {/* CampaignCard */}
      <section>
        <h2 className="ch-label">CampaignCard</h2>
        <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap", marginTop: "var(--space-3)" }}>
          <CampaignCard
            title="Clean water for Kisumu District"
            org="WaterAid Kenya"
            verified
            verifiedLabel={tStatus("verified")}
            status="live"
            statusLabel={tStatus("live")}
            raised={{ eurCents: 3_248_000n }}
            target={{ eurCents: 20_000_000n }}
            donors={312}
            daysLeft={9}
            featured
            successLineLabel={tProgress("successLine")}
            metaLabel="312 donors · 9 days left"
          />
        </div>
      </section>

      {/* MilestoneTrack */}
      <section>
        <h2 className="ch-label">MilestoneTrack</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <MilestoneTrack
            tranches={[
              { label: "Step 1", amount: { eurCents: 5_000_000n }, state: "released", stateLabel: tMilestone("released") },
              { label: "Step 2", amount: { eurCents: 5_000_000n }, state: "voting",   stateLabel: tMilestone("voting") },
              { label: "Step 3", amount: { eurCents: 5_000_000n }, state: "locked",   stateLabel: tMilestone("locked") },
            ]}
          />
        </div>
      </section>

      {/* VoteMeter */}
      <section>
        <h2 className="ch-label">VoteMeter</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <VoteMeter
            turnout={62} approval={78}
            turnoutLabel={tVote("turnout")} approvalLabel={tVote("approval")}
            quorumNeededLabel={tVote("quorumNeeded")} passNeededLabel={tVote("passNeeded")}
            verdictMetLabel={tVote("verdictMet")} verdictNotMetLabel={tVote("verdictNotMet")}
            approvalMetLabel={tVote("approvalMet")} approvalNotMetLabel={tVote("approvalNotMet")}
          />
        </div>
      </section>

      {/* TrustScore */}
      <section>
        <h2 className="ch-label">TrustScore</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <TrustScore
            score={82} version="2.1"
            components={[
              { label: "On-chain track record", value: 0.9 },
              { label: "Audit history", value: 0.75 },
              { label: "Community approval", value: 0.8 },
              { label: "Legal registration", value: 1.0 },
              { label: "Response time", value: 0.6 },
            ]}
            methodologyLabel={tTrust("methodology")}
          />
        </div>
      </section>

      {/* LedgerTable */}
      <section>
        <h2 className="ch-label">LedgerTable</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <LedgerTable
            colTime={tLedger("time")} colFrom={tLedger("from")}
            colType={tLedger("type")} colAmount={tLedger("amount")} colTx={tLedger("tx")}
            rows={[
              { time: "2025-03-01 14:32", from: "0xABCD1234BEEF5678", label: "Donation", amount: 100_000_000n, tx: "0xabc123def456789abc123" },
              { time: "2025-03-01 09:11", from: "0x9876FEDC5432ABCD", label: "Donation", amount: 250_000_000n, tx: "0xfed987cba654321fed987" },
            ]}
          />
        </div>
      </section>

      {/* Address */}
      <section>
        <h2 className="ch-label">Address</h2>
        <div style={{ marginTop: "var(--space-3)" }}>
          <Address
            address="0x1234567890abcdef1234567890abcdef12345678"
            copyLabel={tAddr("copy")}
            copiedLabel={tAddr("copied")}
          />
        </div>
      </section>
    </div>
  );
}
