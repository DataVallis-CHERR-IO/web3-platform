"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { createPublicClient, custom, http, type Address, type Hash, type PublicClient } from "viem";
import { Button } from "@cherrio/ui";
import { useRouter } from "@/i18n/routing";
import { AdminWalletGate, type AdminWallets } from "@/components/admin/AdminWallets";
import { readRoles, waitForConsoleTx, type ConsoleChain } from "@/lib/contracts/console-client";
import { sendCreateSubPool, toSubpoolFailure } from "@/lib/admin/subpool-client";

// Admin → Emergency Pool (TASK-046): one button per seeded theme that is not on
// chain yet. The Operator's own wallet signs `createSubPool(id)` after a
// simulation through /api/rpc; the hash is recorded in audit_log; the table
// updates when the indexer has seen `SubPoolCreated`.

interface Props {
  appEnv: string;
  chainId: number;
  pool: Address;
  /** Timelock + PlatformConfig for the role check; null on an unconfigured local env (the contract judges). */
  roles: ConsoleChain | null;
  explorerUrl: string | null;
  missing: { poolId: number; name: string }[];
}

export function SubpoolActions(props: Props) {
  const t = useTranslations("admin.guardian.panel");
  return (
    <AdminWalletGate appEnv={props.appEnv} loading={<p role="status" className="text-[var(--ink)]">{t("loading")}</p>}>
      {(w) => <ActionsUi {...props} {...w} />}
    </AdminWalletGate>
  );
}

function ActionsUi(props: Props & AdminWallets) {
  const t = useTranslations("admin.pool");
  const tPanel = useTranslations("admin.guardian.panel");
  const tErr = useTranslations("campaignPage.lifecycle.errors");
  const router = useRouter();
  const [reader, setReader] = React.useState<PublicClient | null>(null);
  const [operator, setOperator] = React.useState<Address | null | undefined>(undefined);
  const [rolesFailed, setRolesFailed] = React.useState(false);
  const [busy, setBusy] = React.useState<number | null>(null);
  const [message, setMessage] = React.useState<{ kind: "error" | "ok"; text: string; tx?: Hash } | null>(null);
  // Sub-pools sent (or found on chain) that the indexer has not shown yet: no
  // second button (it would only meet PoolAlreadyExists); the page re-reads every 15 s.
  const [pending, setPending] = React.useState<number[]>([]);
  const { chainId, roles: roleChain } = props;
  const missingIds = props.missing.map((m) => m.poolId).join(",");

  React.useEffect(() => {
    // The table moved on: drop pending ids the server no longer lists as missing.
    const still = new Set(missingIds.split(",").filter(Boolean).map(Number));
    setPending((p) => (p.some((id) => !still.has(id)) ? p.filter((id) => still.has(id)) : p));
  }, [missingIds]);

  React.useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(timer);
  }, [pending.length, router]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = props.readProvider ? custom(await props.readProvider(chainId)) : http(`${window.location.origin}/api/rpc`, { retryCount: 0 });
      if (!cancelled) setReader(createPublicClient({ transport }));
    })();
    return () => { cancelled = true; };
  }, [props.readProvider, chainId]);

  React.useEffect(() => {
    if (!reader || props.wallets.length === 0) return;
    if (!roleChain) {
      setOperator(props.wallets[0]!.account);
      return;
    }
    void Promise.all(props.wallets.map(async (w) => ({ account: w.account, operator: (await readRoles(reader, roleChain, w.account)).operator })))
      .then((list) => { setOperator(list.find((r) => r.operator)?.account ?? null); setRolesFailed(false); })
      .catch((e: unknown) => { console.error("[subpools] roles", e); setRolesFailed(true); });
  }, [reader, props.wallets, roleChain]);

  const wallet = operator ? props.wallets.find((w) => w.account === operator) ?? null : null;

  const create = async (poolId: number) => {
    if (!wallet || !reader) return;
    setMessage(null);
    setBusy(poolId);
    try {
      let hash: Hash;
      try {
        hash = await sendCreateSubPool(await wallet.provider(chainId), wallet.account, { chainId, pool: props.pool, poolId }, { reader });
      } catch (e) {
        console.error("[subpools] send", e);
        const failure = toSubpoolFailure(e);
        if (failure === "already_done") {
          // Already on chain (sent a moment ago, or by someone else): wait for the indexer.
          setPending((p) => [...p, poolId]);
          setMessage({ kind: "ok", text: t("alreadyOnChain") });
        } else {
          setMessage({ kind: "error", text: tErr(failure) });
        }
        return;
      }
      await fetch("/api/admin/emergency-pool/subpools/sent", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poolId, txHash: hash }),
      }).catch((e: unknown) => console.error("[subpools] sent", e));
      const outcome = await waitForConsoleTx(reader, hash);
      if (outcome !== "reverted") setPending((p) => [...p, poolId]);
      setMessage(
        outcome === "success" ? { kind: "ok", text: t("sent"), tx: hash }
          : outcome === "reverted" ? { kind: "error", text: t("reverted"), tx: hash }
          : { kind: "ok", text: t("unknown"), tx: hash }
      );
      if (outcome === "success") router.refresh();
    } finally {
      setBusy(null);
    }
  };

  const txLink = (tx: Hash) =>
    props.explorerUrl ? (
      <a href={`${props.explorerUrl}/tx/${tx}`} target="_blank" rel="noreferrer" className="ch-mono underline break-all">{tx}</a>
    ) : <span className="ch-mono break-all">{tx}</span>;

  return (
    <section className="ch-panel p-5 flex flex-col gap-4" aria-labelledby="subpool-create">
      <h2 id="subpool-create" className="text-lg font-display uppercase text-[var(--ink)]">{t("createTitle")}</h2>
      <p className="text-sm text-[var(--ink)]">{t("createText")}</p>
      {!props.walletsReady ? null : props.wallets.length === 0 ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("noWallet")}</p>
      ) : rolesFailed ? (
        <p role="alert" className="text-sm font-bold text-[var(--ink)]">{tPanel("readFailed")}</p>
      ) : operator === null ? (
        <p className="text-sm font-bold text-[var(--ink)]">{t("needsOperator")}</p>
      ) : null}
      <ul className="flex flex-col" aria-label={t("missingList")}>
        {props.missing.map((m) => (
          <li key={m.poolId} className="flex flex-wrap items-center justify-between gap-3 py-3 border-t border-[var(--ink-muted)]">
            <span className="text-base font-bold text-[var(--ink)] min-w-0 break-words">
              {m.name} <span className="ch-mono font-normal">({m.poolId})</span>
            </span>
            {pending.includes(m.poolId) ? (
              <span className="text-sm text-[var(--ink)]">{t("waitingIndexer")}</span>
            ) : (
              <Button
                aria-label={t("create", { theme: m.name })}
                disabled={busy !== null || !wallet || !reader}
                onClick={() => void create(m.poolId)}
              >
                {t("createShort")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {busy !== null && <p role="status" className="text-sm text-[var(--ink)]">{tPanel("working")}</p>}
      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className="text-sm font-bold text-[var(--ink)] flex flex-col gap-1">
          <span>{message.text}</span>
          {message.tx && txLink(message.tx)}
        </div>
      )}
    </section>
  );
}
