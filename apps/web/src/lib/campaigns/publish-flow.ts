import { getAddress, type Address, type EIP1193Provider, type Hash } from "viem";
import {
  isOperator as isOperatorOnChain,
  publishCampaign as publishOnChain,
  PublishCheckError,
  waitForPublish as waitOnChain,
  type PreparedPublishCall,
} from "./publish-client";

// The browser publish flow of one APPROVED campaign (TASK-010c), shared by the
// campaign's "Publish on Polygon" button and Admin → Demo campaigns →
// "Publish all" (TASK-038c): prepare on the server → find the operator wallet →
// sign createCampaign → report the hash → wait for the receipt → link through
// the indexer. Every dependency is injected so the flow is unit-tested.

export type PublishStep = "preparing" | "checking" | "signing" | "mining" | "linking";

/** Rejects with "timeout" when the wallet does not answer in time. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export type PostResult<T> = { ok: true; data: T } | { ok: false; code: string };

export async function postJson<T>(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<PostResult<T>> {
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    return res.ok ? { ok: true, data: json } : { ok: false, code: json.error ?? `http_${res.status}` };
  } catch {
    return { ok: false, code: "network" };
  }
}

/** The part of a Privy wallet the flow needs. */
export interface WalletLike {
  address: string;
  switchChain(chainId: number): Promise<unknown>;
  getEthereumProvider(): Promise<unknown>;
}

export interface OperatorWallet {
  provider: EIP1193Provider;
  account: Address;
}

/** The first wallet that holds OPERATOR_ROLE on this chain; every wallet call has a time limit. */
export async function pickOperatorWallet(
  wallets: WalletLike[],
  call: Pick<PreparedPublishCall, "chainId" | "platformConfig">,
  isOperator: typeof isOperatorOnChain = isOperatorOnChain
): Promise<{ chosen: OperatorWallet | null; checked: string[] }> {
  const checked: string[] = [];
  for (const wallet of wallets) {
    const account = getAddress(wallet.address);
    checked.push(account);
    await withTimeout(wallet.switchChain(call.chainId), 60_000).catch(() => undefined);
    const provider = (await withTimeout(wallet.getEthereumProvider(), 20_000).catch(() => null)) as EIP1193Provider | null;
    if (!provider) continue;
    if (await withTimeout(isOperator(provider, account, call.platformConfig), 20_000).catch(() => false)) {
      return { chosen: { provider, account }, checked };
    }
  }
  return { chosen: null, checked };
}

export type PublishFlowResult =
  | { kind: "deployed" }
  /** Sent and mined, but the indexer has not linked it within the wait. "Check status" later. */
  | { kind: "not_linked_yet" }
  | { kind: "prepare_failed"; code: string }
  | { kind: "no_operator_wallet"; checked: string[] }
  | { kind: "check_failed"; code: PublishCheckError["code"] }
  | { kind: "record_failed"; txHash: Hash }
  | { kind: "reverted" }
  | { kind: "rejected_by_user" }
  | { kind: "failed" };

export interface PublishFlowDeps {
  wallets: WalletLike[];
  /** A wallet found for an earlier campaign of the same batch: no second role check. */
  operator?: OperatorWallet | null;
  publishTxHash?: string | null;
  onStep?: (step: PublishStep) => void;
  /** Called once the operator wallet is known, so a batch can reuse it. */
  onOperator?: (operator: OperatorWallet) => void;
  post?: <T>(url: string, body: unknown) => Promise<PostResult<T>>;
  pick?: typeof pickOperatorWallet;
  publish?: typeof publishOnChain;
  wait?: typeof waitOnChain;
  sleep?: (ms: number) => Promise<void>;
  linkAttempts?: number;
}

export async function publishFlow(campaignId: string, deps: PublishFlowDeps): Promise<PublishFlowResult> {
  const post = deps.post ?? postJson;
  const pick = deps.pick ?? pickOperatorWallet;
  const publish = deps.publish ?? publishOnChain;
  const wait = deps.wait ?? waitOnChain;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const step = deps.onStep ?? (() => undefined);
  const check = async () => {
    const result = await post<{ status: string }>(`/api/admin/campaigns/${campaignId}/publish/check`, {});
    return result.ok && result.data.status === "DEPLOYED";
  };

  try {
    step("preparing");
    const prepared = await post<PreparedPublishCall>(`/api/admin/campaigns/${campaignId}/publish/prepare`, {});
    if (!prepared.ok) return { kind: "prepare_failed", code: prepared.code };
    const call = prepared.data;

    step("checking");
    let operator = deps.operator ?? null;
    if (!operator) {
      const found = await pick(deps.wallets, call);
      if (!found.chosen) return { kind: "no_operator_wallet", checked: found.checked };
      operator = found.chosen;
      deps.onOperator?.(operator);
    } else {
      await withTimeout(Promise.resolve(deps.wallets.find((w) => getAddress(w.address) === operator!.account)?.switchChain(call.chainId)), 60_000).catch(
        () => undefined
      );
    }

    step("signing");
    const outcome = await publish(operator.provider, operator.account, call, (deps.publishTxHash as Hash | null) ?? null);
    let recordFailed: Hash | null = null;
    if (outcome.kind === "sent") {
      const sent = await post(`/api/admin/campaigns/${campaignId}/publish/sent`, { txHash: outcome.txHash });
      if (!sent.ok) recordFailed = outcome.txHash;
      step("mining");
      if (!(await wait(operator.provider, outcome.txHash))) return { kind: "reverted" };
    }

    // The indexer needs a few blocks; try for about a minute.
    step("linking");
    const attempts = deps.linkAttempts ?? 12;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (await check()) return recordFailed ? { kind: "record_failed", txHash: recordFailed } : { kind: "deployed" };
      if (attempt < attempts - 1) await sleep(5_000);
    }
    return recordFailed ? { kind: "record_failed", txHash: recordFailed } : { kind: "not_linked_yet" };
  } catch (e) {
    if (e instanceof PublishCheckError) return { kind: "check_failed", code: e.code };
    if ((e as { code?: number })?.code === 4001) return { kind: "rejected_by_user" };
    console.error("[publish]", e);
    return { kind: "failed" };
  }
}
