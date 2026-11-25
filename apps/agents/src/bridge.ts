/**
 * apps/agents/src/bridge.ts
 * The wallet an agent's browser sees. The page gets a normal EIP-1193 provider
 * (announced through EIP-6963, so Privy lists it under "detected wallets"),
 * but the key never enters the page: every request is passed to Node, checked
 * against the signer policy, and only then signed.
 *
 * Reads go to the agents' own RPC (never the app's indexer quota). Anything
 * that is not on a list below is refused.
 */
import type { LocalAccount } from "viem/accounts";
import { checkFees, checkSiweMessage, checkTransaction, checkTypedData, type PolicyContext, type TxRequest, type Verdict } from "./policy.js";

/** Read-only JSON-RPC methods forwarded as they are. */
const READS = new Set([
  "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice",
  "eth_getBalance", "eth_getBlockByNumber", "eth_getCode", "eth_getLogs",
  "eth_getTransactionByHash", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas", "net_version",
]);

export class RefusedError extends Error {
  code = 4100; // EIP-1193 "unauthorized"
  override name = "RefusedError";
}

export interface BridgeEvent {
  method: string;
  outcome: "signed" | "refused";
  what: string;
  to?: string;
  hash?: string;
}

export interface BridgeOptions {
  account: LocalAccount;
  host: string;
  policy: PolicyContext;
  /** Raw JSON-RPC to the agents' RPC URL. */
  rpc: (method: string, params: unknown[]) => Promise<unknown>;
  /** Signs and sends an allowed transaction; returns its hash. */
  send: (tx: TxRequest) => Promise<`0x${string}`>;
  onEvent?: (event: BridgeEvent) => void;
}

const hexToUtf8 = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex").toString("utf8");

export function createBridge(opts: BridgeOptions) {
  const { account, policy } = opts;
  const chainHex = `0x${policy.expectedChainId.toString(16)}`;
  const note = (e: BridgeEvent) => opts.onEvent?.(e);
  const deny = (method: string, v: Verdict & { ok: false }, to?: string): never => {
    note({ method, outcome: "refused", what: v.reason, to });
    throw new RefusedError(v.reason);
  };

  return async function request(method: string, params: unknown[] = []): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return chainHex;
      case "eth_accounts":
      case "eth_requestAccounts":
        return [account.address];
      case "wallet_switchEthereumChain": {
        const wanted = (params[0] as { chainId?: string } | undefined)?.chainId;
        if (wanted?.toLowerCase() !== chainHex) deny(method, { ok: false, reason: `refused chain ${wanted}` });
        return null;
      }
      case "personal_sign": {
        const [raw, who] = params as [string, string];
        const message = raw.startsWith("0x") ? hexToUtf8(raw) : raw;
        const v = checkSiweMessage(message, { host: opts.host, address: who ?? account.address, chainId: policy.expectedChainId });
        if (!v.ok) deny(method, v);
        if ((who ?? account.address).toLowerCase() !== account.address.toLowerCase()) {
          deny(method, { ok: false, reason: "not this wallet" });
        }
        note({ method, outcome: "signed", what: "sign-in" });
        return account.signMessage({ message });
      }
      case "eth_signTypedData_v4": {
        const [who, raw] = params as [string, string];
        if ((who ?? "").toLowerCase() !== account.address.toLowerCase()) deny(method, { ok: false, reason: "not this wallet" });
        const typed = JSON.parse(raw) as {
          domain?: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown>;
        };
        const v = checkTypedData(typed, policy.expectedChainId);
        if (!v.ok) deny(method, v);
        const { EIP712Domain: _domain, ...types } = typed.types;
        note({ method, outcome: "signed", what: `typed data ${typed.primaryType}` });
        const args = { domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message };
        return account.signTypedData(args as unknown as Parameters<LocalAccount["signTypedData"]>[0]);
      }
      case "eth_sendTransaction": {
        const tx = params[0] as TxRequest & { from?: string };
        if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
          deny(method, { ok: false, reason: "not this wallet" }, tx.to ?? undefined);
        }
        const fees = checkFees(tx);
        if (!fees.ok) deny(method, fees, tx.to ?? undefined);
        const v = await checkTransaction(tx, policy);
        if (!v.ok) deny(method, v, tx.to ?? undefined);
        const hash = await opts.send(tx);
        note({ method, outcome: "signed", what: (v as { what: string }).what, to: tx.to ?? undefined, hash });
        return hash;
      }
      default:
        if (READS.has(method)) return opts.rpc(method, params);
        return deny(method, { ok: false, reason: `method not allowed: ${method}` });
    }
  };
}

/**
 * Script for `page.addInitScript`: defines `window.ethereum` and announces the
 * wallet (EIP-6963). It calls `window.__agentWallet(json)`, which the runner
 * exposes with `page.exposeFunction` and wires to `createBridge`.
 */
export interface WalletIdentity { name: string; rdns: string; isMetaMask: boolean }

/** How the wallet presents itself to the page. */
export const TEST_WALLET: WalletIdentity = { name: "CHERR.IO test wallet", rdns: "io.cherr.agents", isMetaMask: false };
/**
 * Privy's wallet list shows MetaMask, Coinbase, Rainbow and WalletConnect but no
 * other injected wallet (run 45601917695). In the agents' own browser the wallet
 * therefore answers as MetaMask; what it signs is decided by the same policy.
 */
export const AS_METAMASK: WalletIdentity = { name: "MetaMask", rdns: "io.metamask", isMetaMask: true };

export function injectedWalletScript(identity: WalletIdentity = TEST_WALLET): string {
  return `(() => {
  const listeners = {};
  const provider = {
    isMetaMask: ${identity.isMetaMask ? "true" : "false"},
    async request({ method, params }) {
      const res = JSON.parse(await window.__agentWallet(JSON.stringify({ method, params: params || [] })));
      if (res.error) { const e = new Error(res.error.message); e.code = res.error.code; throw e; }
      return res.result;
    },
    on(event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
  };
  window.ethereum = provider;
  const info = Object.freeze({ uuid: "6f1c2f0e-0c61-4c61-9a61-c4e221000061", name: ${JSON.stringify(identity.name)}, rdns: ${JSON.stringify(identity.rdns)},
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8'/%3E%3C/svg%3E" });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;
}
