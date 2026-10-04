"use client";
import * as React from "react";
import { useTranslations } from "next-intl";
import { useWallets } from "@privy-io/react-auth";
import { createPublicClient, custom, getAddress, http, type Address, type EIP1193Provider, type Hash, type Hex, type PublicClient } from "viem";
import { Button } from "@cherrio/ui";
import { formatUsdc } from "@cherrio/shared/money";
import { useRouter } from "@/i18n/routing";
import { useAppAuth } from "@/components/auth/PrivyClientProvider";
import { LocalDateTime } from "@/components/LocalDateTime";
import {
  CONFIG_PARAMS, durationParts, formatPercent, humanInput, paramSpec, parseHuman, rawToString,
  type ConfigKey, type DurationUnit, type ParamSpec, type ParseFailure, type RawValue,
} from "@/lib/contracts/config-params";
import {
  buildOperation, cancelChange, executeChange, readOperation, readRoles, readSnapshot, scheduleChange, toConsoleFailure,
  waitForConsoleTx, type ConsoleChain, type TxOutcome, type ConsoleFailure, type ConsoleSnapshot, type OperationStatus, type WalletRoles,
} from "@/lib/contracts/console-client";
import { operationId, safeTransactionBuilderJson, scheduleBatchData, type BatchOperation } from "@/lib/contracts/timelock";
import type { ChangeLine, ContractChangeView } from "@/lib/contracts/changes";

// Admin → Contracts (TASK-034b, ADR-046): PlatformConfig values in human units,
// changed only through the TimelockController, signed in the admin's own wallet.

interface Props {
  chain: ConsoleChain;
  networkName: string;
  explorerUrl: string | null;
  appEnv: string;
}

interface AdminWallet {
  account: Address;
  provider: (chainId: number) => Promise<EIP1193Provider>;
}

/** Test wallet for Playwright: honoured only when APP_ENV=local (never deployed). */
interface E2eWindow {
  __cherrioE2eWallet?: { address: string; provider: EIP1193Provider };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); }
    );
  });
}

export function ContractConsole(props: Props) {
  const { isAvailable } = useAppAuth();
  const t = useTranslations("admin.contracts");
  const [e2e, setE2e] = React.useState<AdminWallet | null>(null);
  const [checked, setChecked] = React.useState(props.appEnv !== "local");
  React.useEffect(() => {
    if (props.appEnv !== "local") return;
    const injected = (window as unknown as E2eWindow).__cherrioE2eWallet;
    if (injected) setE2e({ account: getAddress(injected.address), provider: async () => injected.provider });
    setChecked(true);
  }, [props.appEnv]);
  if (!checked) return <p role="status" className="text-[var(--ink)]">{t("loading")}</p>;
  if (e2e) return <ConsoleUi {...props} wallets={[e2e]} walletsReady readProvider={e2e.provider} />;
  if (isAvailable) return <PrivyConsole {...props} />;
  return <ConsoleUi {...props} wallets={[]} walletsReady />;
}

function PrivyConsole(props: Props) {
  const { wallets, ready } = useWallets();
  const external = React.useMemo(
    () =>
      wallets
        .filter((w) => w.walletClientType !== "privy")
        .map<AdminWallet>((w) => ({
          account: getAddress(w.address),
          provider: async (chainId) => {
            await withTimeout(w.switchChain(chainId), 60_000).catch(() => undefined);
            return (await withTimeout(w.getEthereumProvider(), 20_000)) as EIP1193Provider;
          },
        })),
    [wallets]
  );
  return <ConsoleUi {...props} wallets={external} walletsReady={ready} />;
}

type FieldState = { amount: string; unit: DurationUnit };
type Busy = null | "schedule" | `execute:${string}` | `cancel:${string}`;

function ConsoleUi(props: Props & { wallets: AdminWallet[]; walletsReady: boolean; readProvider?: AdminWallet["provider"] }) {
  const t = useTranslations("admin.contracts");
  const router = useRouter();
  const { chain } = props;
  const [reader, setReader] = React.useState<PublicClient | null>(null);
  const [snapshot, setSnapshot] = React.useState<ConsoleSnapshot | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [fields, setFields] = React.useState<Record<ConfigKey, FieldState> | null>(null);
  const [roles, setRoles] = React.useState<{ account: Address; roles: WalletRoles }[]>([]);
  const [changes, setChanges] = React.useState<ContractChangeView[]>([]);
  const [statuses, setStatuses] = React.useState<Record<string, OperationStatus>>({});
  const [reviewing, setReviewing] = React.useState(false);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [message, setMessage] = React.useState<{ kind: "error" | "ok"; text: string; tx?: Hash } | null>(null);

  // Reads: through the E2E wallet, else the same-origin read-only RPC proxy.
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const transport = props.readProvider ? custom(await props.readProvider(chain.chainId)) : http(`${window.location.origin}/api/rpc`);
      if (!cancelled) setReader(createPublicClient({ transport }));
    })();
    return () => { cancelled = true; };
  }, [props.readProvider, chain.chainId]);

  const load = React.useCallback(async () => {
    if (!reader) return;
    try {
      const snap = await readSnapshot(reader, chain);
      setSnapshot(snap);
      setFields(Object.fromEntries(CONFIG_PARAMS.map((p) => {
        const h = humanInput(p, snap.values[p.key]);
        return [p.key, { amount: h.amount, unit: h.unit ?? "days" }];
      })) as Record<ConfigKey, FieldState>);
      setLoadError(false);
    } catch (e) {
      console.error("[contracts] read", e);
      setLoadError(true);
    }
    try {
      const res = await fetch("/api/admin/contracts/changes");
      const list = res.ok ? ((await res.json()) as { changes: ContractChangeView[] }).changes : [];
      setChanges(list);
      const open = list.filter((c) => !c.executedAt && !c.cancelledAt);
      const entries = await Promise.all(
        open.map(async (c) => [c.id, await readOperation(reader, chain.timelock, c.operationId as Hex)] as const)
      );
      setStatuses(Object.fromEntries(entries));
    } catch (e) {
      console.error("[contracts] changes", e);
    }
  }, [reader, chain]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!reader || props.wallets.length === 0) return;
    let cancelled = false;
    void Promise.all(
      props.wallets.map(async (w) => ({ account: w.account, roles: await readRoles(reader, chain, w.account) }))
    ).then((r) => { if (!cancelled) setRoles(r); }, (e: unknown) => console.error("[contracts] roles", e));
    return () => { cancelled = true; };
  }, [reader, props.wallets, chain]);

  const walletWith = (role: keyof WalletRoles) => {
    const found = roles.find((r) => r.roles[role]);
    return found ? props.wallets.find((w) => w.account === found.account) ?? null : null;
  };

  // ── The form ──────────────────────────────────────────────────────────────
  const parsed = React.useMemo(() => {
    if (!fields || !snapshot) return null;
    return CONFIG_PARAMS.map((spec) => {
      const f = fields[spec.key];
      const result = parseHuman(spec, f.amount, f.unit);
      const current = snapshot.values[spec.key];
      const changed = result.ok && rawToString(result.value) !== rawToString(current);
      return { spec, result, current, changed };
    });
  }, [fields, snapshot]);
  const pending = parsed?.filter((p) => p.changed) ?? [];
  const invalid = parsed?.some((p) => !p.result.ok) ?? false;

  const fieldError = (reason: ParseFailure, spec: ParamSpec) =>
    reason === "below_min" || reason === "above_max"
      ? t(`errors.field.${reason}`, { min: humanText(t, spec, spec.min), max: humanText(t, spec, spec.max) })
      : t(`errors.field.${reason}`);

  async function post(url: string, body: unknown): Promise<string | null> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    return json.error ?? `http_${res.status}`;
  }

  const outcomeMessage = (outcome: TxOutcome, done: string, tx: Hash) =>
    outcome === "success" ? { kind: "ok" as const, text: done, tx }
    : outcome === "reverted" ? { kind: "error" as const, text: t("errors.reverted"), tx }
    : { kind: "ok" as const, text: t("unconfirmed"), tx };

  const failText = (code: ConsoleFailure | string) =>
    t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : t("errors.failed");

  async function schedule() {
    if (!snapshot || pending.length === 0) return;
    const signer = walletWith("proposer");
    if (!signer) return;
    setBusy("schedule");
    setMessage(null);
    let tx: Hash | undefined;
    try {
      const op = buildOperation(chain, Object.fromEntries(pending.map((p) => [p.spec.key, (p.result as { value: RawValue }).value])));
      const provider = await signer.provider(chain.chainId);
      tx = await scheduleChange(provider, signer.account, chain, op, snapshot.minDelay, reader ?? undefined);
      const recordError = await post("/api/admin/contracts/changes", {
        chainId: chain.chainId, timelock: chain.timelock, operationId: operationId(op), targets: op.targets, payloads: op.payloads,
        predecessor: op.predecessor, salt: op.salt, delaySeconds: Number(snapshot.minDelay),
        previous: Object.fromEntries(pending.map((p) => [p.spec.key, rawToString(p.current)])), txHash: tx,
      });
      if (recordError) {
        setMessage({ kind: "error", text: t("errors.recordFailed", { code: recordError }), tx });
        return;
      }
      setMessage({ kind: "ok", text: t("confirming"), tx });
      const outcome = await waitForConsoleTx(reader ?? createPublicClient({ transport: custom(provider) }), tx);
      setMessage(outcomeMessage(outcome, t("scheduled"), tx));
      setReviewing(false);
      await load();
      router.refresh();
    } catch (e) {
      console.error("[contracts] write", e);
      setMessage({ kind: "error", text: failText(toConsoleFailure(e)), tx });
    } finally {
      setBusy(null);
    }
  }

  function downloadForSafe() {
    if (!snapshot || pending.length === 0) return;
    const op = buildOperation(chain, Object.fromEntries(pending.map((p) => [p.spec.key, (p.result as { value: RawValue }).value])));
    const json = safeTransactionBuilderJson(chain.chainId, chain.timelock, scheduleBatchData(op, snapshot.minDelay), t("safeFileName"));
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `cherrio-config-change-${operationId(op).slice(2, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function close(change: ContractChangeView, kind: "execute" | "cancel") {
    const signer = walletWith(kind === "execute" ? "executor" : "canceller");
    if (!signer) return;
    setBusy(`${kind}:${change.id}`);
    setMessage(null);
    let tx: Hash | undefined;
    try {
      const op: BatchOperation = {
        targets: change.targets.map((a) => getAddress(a)), payloads: change.payloads as Hex[],
        predecessor: change.predecessor as Hex, salt: change.salt as Hex,
      };
      const provider = await signer.provider(chain.chainId);
      tx = kind === "execute"
        ? await executeChange(provider, signer.account, chain, op, change.operationId as Hex, reader ?? undefined)
        : await cancelChange(provider, signer.account, chain, change.operationId as Hex, reader ?? undefined);
      const recordError = await post(`/api/admin/contracts/changes/${change.id}/${kind === "execute" ? "executed" : "cancelled"}`, { txHash: tx });
      if (recordError) setMessage({ kind: "error", text: t("errors.recordFailed", { code: recordError }), tx });
      if (!recordError) setMessage({ kind: "ok", text: t("confirming"), tx });
      const outcome = await waitForConsoleTx(reader ?? createPublicClient({ transport: custom(provider) }), tx);
      if (!recordError) setMessage(outcomeMessage(outcome, t(kind === "execute" ? "executed" : "cancelled"), tx));
      await load();
    } catch (e) {
      console.error("[contracts] write", e);
      setMessage({ kind: "error", text: failText(toConsoleFailure(e)), tx });
    } finally {
      setBusy(null);
    }
  }

  const txLink = (tx: Hash) =>
    props.explorerUrl ? (
      <a href={`${props.explorerUrl}/tx/${tx}`} target="_blank" rel="noreferrer" className="ch-mono underline break-all">{tx}</a>
    ) : <span className="ch-mono break-all">{tx}</span>;

  if (loadError && !snapshot) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="ch-panel p-5 font-bold text-[var(--ink)]">{t("errors.readFailed")}</p>
        <div><Button variant="ghost" onClick={() => void load()}>{t("retry")}</Button></div>
      </div>
    );
  }
  if (!snapshot || !fields || !parsed) return <p role="status" className="text-[var(--ink)]">{t("loading")}</p>;

  const proposer = walletWith("proposer");
  const open = changes.filter((c) => !c.executedAt && !c.cancelledAt);
  const closed = changes.filter((c) => c.executedAt || c.cancelledAt).slice(0, 10);

  return (
    <div className="flex flex-col gap-10">
      {/* Network, timelock, wallet */}
      <section className="ch-panel p-5 flex flex-col gap-3" aria-labelledby="contracts-setup">
        <h2 id="contracts-setup" className="text-xl font-display uppercase text-[var(--ink)]">{t("setup.title")}</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-[14rem_1fr] gap-x-4 gap-y-2 text-sm text-[var(--ink)]">
          <dt className="ch-label">{t("setup.network")}</dt><dd>{props.networkName} ({chain.chainId})</dd>
          <dt className="ch-label">{t("setup.platformConfig")}</dt><dd className="ch-mono break-all">{chain.platformConfig}</dd>
          <dt className="ch-label">{t("setup.timelock")}</dt><dd className="ch-mono break-all">{chain.timelock}</dd>
          <dt className="ch-label">{t("setup.delay")}</dt><dd>{durationText(t, snapshot.minDelay)}</dd>
        </dl>
        {!props.walletsReady ? null : props.wallets.length === 0 ? (
          <p className="text-sm font-bold text-[var(--ink)]">{t("setup.noWallet")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-[var(--ink)]" aria-label={t("setup.wallets")}>
            {roles.map((r) => {
              const held = (Object.keys(r.roles) as (keyof WalletRoles)[]).filter((k) => r.roles[k]);
              return (
                <li key={r.account}>
                  <span className="ch-mono break-all">{r.account}</span>: {held.length ? held.map((k) => t(`roles.${k}`)).join(", ") : t("roles.none")}
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-sm text-[var(--ink)]">{t("setup.consequence")}</p>
      </section>

      {/* Values */}
      <section className="flex flex-col gap-4" aria-labelledby="contracts-values">
        <h2 id="contracts-values" className="text-xl font-display uppercase text-[var(--ink)]">{t("values.title")}</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {parsed.map(({ spec, result, current, changed }) => {
            const f = fields[spec.key];
            const id = `param-${spec.key}`;
            const error = result.ok ? undefined : fieldError(result.reason, spec);
            const set = (patch: Partial<FieldState>) => { setReviewing(false); setFields({ ...fields, [spec.key]: { ...f, ...patch } }); };
            return (
              <div key={spec.key} className={`ch-panel p-4 flex flex-col gap-2 ${changed ? "border-[var(--accent)]" : ""}`}>
                <label htmlFor={id} className="ch-label">{t(`params.${spec.key}.label`)}</label>
                <p className="text-sm text-[var(--ink)]">{t(`params.${spec.key}.hint`)}</p>
                <p className="text-sm text-[var(--ink)]">
                  {t("values.current")}: <strong>{humanText(t, spec, current)}</strong>{" "}
                  <span className="ch-mono text-xs text-[var(--ink-muted)]">({t("values.raw", { value: rawToString(current) })})</span>
                </p>
                <div className={error ? "ch-field ch-field-error" : "ch-field"}>
                  <div className="flex gap-2 items-center">
                    <input
                      id={id}
                      className={`ch-input ${spec.kind === "address" ? "ch-input-mono" : ""}`}
                      inputMode={spec.kind === "address" ? "text" : spec.kind === "duration" ? "numeric" : "decimal"}
                      value={f.amount}
                      onChange={(e) => set({ amount: e.target.value })}
                      aria-invalid={error ? "true" : undefined}
                      aria-describedby={`${id}-note`}
                      disabled={busy !== null}
                    />
                    {spec.kind === "duration" && (
                      <select
                        className="ch-input w-auto"
                        aria-label={t("values.unit", { param: t(`params.${spec.key}.label`) })}
                        value={f.unit}
                        onChange={(e) => set({ unit: e.target.value as DurationUnit })}
                        disabled={busy !== null}
                      >
                        {(["minutes", "hours", "days"] as const).map((u) => <option key={u} value={u}>{t(`unitNames.${u}`)}</option>)}
                      </select>
                    )}
                    {spec.kind === "percent" && <span aria-hidden="true" className="font-bold text-[var(--ink)]">%</span>}
                    {spec.kind === "usdc" && <span aria-hidden="true" className="font-bold text-[var(--ink)]">USDC</span>}
                  </div>
                  <span id={`${id}-note`} className="ch-field-hint">
                    {error ?? (changed && result.ok ? t("values.willBe", { value: humanText(t, spec, result.value) }) : "")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3 items-center">
          <Button variant="primary" disabled={pending.length === 0 || invalid || busy !== null} onClick={() => setReviewing(true)}>
            {t("review", { count: pending.length })}
          </Button>
          {pending.length > 0 && (
            <Button variant="ghost" disabled={busy !== null} onClick={() => void load()}>{t("reset")}</Button>
          )}
        </div>
      </section>

      {reviewing && pending.length > 0 && (
        <section className="ch-panel p-5 flex flex-col gap-4" aria-labelledby="contracts-review">
          <h2 id="contracts-review" className="text-xl font-display uppercase text-[var(--ink)]">{t("reviewTitle")}</h2>
          <ChangeTable t={t} lines={pending.map((p) => ({ key: p.spec.key, from: rawToString(p.current), to: rawToString((p.result as { value: RawValue }).value) }))} />
          <p className="text-sm text-[var(--ink)]">{t("reviewNote", { delay: durationText(t, snapshot.minDelay) })}</p>
          <div className="flex flex-wrap gap-3">
            {proposer ? (
              <Button variant="primary" disabled={busy !== null} onClick={() => void schedule()}>
                {busy === "schedule" ? t("scheduling") : t("schedule")}
              </Button>
            ) : (
              <>
                <p className="text-sm font-bold text-[var(--ink)] basis-full">{t("noProposer")}</p>
                <Button variant="ghost" onClick={downloadForSafe}>{t("downloadSafe")}</Button>
              </>
            )}
            <Button variant="ghost" disabled={busy !== null} onClick={() => setReviewing(false)}>{t("back")}</Button>
          </div>
        </section>
      )}

      {message && (
        <div role={message.kind === "error" ? "alert" : "status"} className="ch-panel p-4 text-sm font-bold text-[var(--ink)] flex flex-col gap-1">
          <span>{message.text}</span>
          {message.tx && <span>{t("transaction")}: {txLink(message.tx)}</span>}
        </div>
      )}

      {/* Scheduled changes */}
      <section className="flex flex-col gap-4" aria-labelledby="contracts-pending">
        <h2 id="contracts-pending" className="text-xl font-display uppercase text-[var(--ink)]">{t("pending.title")}</h2>
        {open.length === 0 ? <p className="text-sm text-[var(--ink)]">{t("pending.none")}</p> : (
          <ul className="flex flex-col gap-4">
            {open.map((c) => {
              const status = statuses[c.id];
              const readyAt = status && status.readyAt > 1n ? new Date(Number(status.readyAt) * 1000) : null;
              return (
                <li key={c.id} className="ch-panel p-4 flex flex-col gap-3">
                  <ChangeTable t={t} lines={c.lines} />
                  <p className="text-sm text-[var(--ink)]">
                    {t(`pending.state.${status?.state ?? "unknown"}`)}
                    {readyAt && status?.state === "waiting" && <> — {t("pending.readyAt")} <LocalDateTime value={readyAt} /></>}
                  </p>
                  <p className="text-sm text-[var(--ink)]">{t("pending.scheduledAt")} <LocalDateTime value={c.scheduledAt} /> · {txLink(c.scheduleTxHash as Hash)}</p>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      variant="primary"
                      disabled={busy !== null || status?.state !== "ready" || !walletWith("executor")}
                      onClick={() => void close(c, "execute")}
                    >
                      {busy === `execute:${c.id}` ? t("executing") : t("execute")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy !== null || !(status?.state === "waiting" || status?.state === "ready") || !walletWith("canceller")}
                      onClick={() => void close(c, "cancel")}
                    >
                      {busy === `cancel:${c.id}` ? t("cancelling") : t("cancel")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {closed.length > 0 && (
          <>
            <h3 className="ch-label">{t("pending.history")}</h3>
            <ul className="flex flex-col gap-2 text-sm text-[var(--ink)]">
              {closed.map((c) => (
                <li key={c.id} className="flex flex-col gap-1">
                  <span>
                    {c.lines.map((l) => t(`params.${l.key}.label`)).join(", ")} —{" "}
                    {c.executedAt ? t("pending.executedOn") : t("pending.cancelledOn")}{" "}
                    <LocalDateTime value={(c.executedAt ?? c.cancelledAt)!} />
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

type T = ReturnType<typeof useTranslations<"admin.contracts">>;

function ChangeTable({ t, lines }: { t: T; lines: ChangeLine[] }) {
  return (
    <div className="ch-ledger-wrap" tabIndex={0} role="region" aria-label={t("reviewTitle")}>
      <table className="ch-ledger">
        <thead>
          <tr><th scope="col">{t("table.param")}</th><th scope="col">{t("table.from")}</th><th scope="col">{t("table.to")}</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const spec = paramSpec(l.key);
            const raw = (v: string) => (spec.kind === "address" ? (v as Address) : BigInt(v));
            return (
              <tr key={l.key}>
                <th scope="row">{t(`params.${l.key}.label`)}</th>
                <td>{l.from === null ? "—" : <>{humanText(t, spec, raw(l.from))} <span className="ch-mono text-xs">({l.from})</span></>}</td>
                <td><strong>{humanText(t, spec, raw(l.to))}</strong> <span className="ch-mono text-xs">({l.to})</span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function durationText(t: T, seconds: bigint): string {
  const p = durationParts(seconds);
  const parts = [
    p.days ? t("units.days", { count: p.days }) : null,
    p.hours ? t("units.hours", { count: p.hours }) : null,
    p.minutes ? t("units.minutes", { count: p.minutes }) : null,
    p.seconds ? t("units.seconds", { count: p.seconds }) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : t("units.none");
}

/** A raw value in words: "25%", "7 days", "1.00 USDC", or the address. */
function humanText(t: T, spec: ParamSpec, value: RawValue): string {
  switch (spec.kind) {
    case "percent": return t("units.percent", { value: formatPercent(value as bigint) });
    case "duration": return durationText(t, value as bigint);
    case "usdc": return t("units.usdc", { value: formatUsdc(value as bigint, { minDecimals: 2, maxDecimals: 6 }) });
    case "address": return getAddress(value as string);
  }
}
