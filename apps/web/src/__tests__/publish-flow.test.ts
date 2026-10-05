import { describe, expect, it } from "vitest";
import type { EIP1193Provider, Hash } from "viem";
import { publishFlow, type PostResult, type PublishFlowDeps, type PublishStep, type WalletLike } from "@/lib/campaigns/publish-flow";
import { PublishCheckError, type PreparedPublishCall } from "@/lib/campaigns/publish-client";
import { publishBatch } from "@/app/[locale]/admin/demo/PublishAll";

// TASK-038c: the shared browser publish flow (single button and "Publish all").
// Server calls, wallet discovery and the chain are fakes; the order of calls is the contract.

const OPERATOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const TX = `0x${"ab".repeat(32)}` as Hash;
const CALL: PreparedPublishCall = {
  chainId: 80002,
  factory: "0x52ba2090E62c9155c04E7E5f28DB9Af00A6AAede",
  platformConfig: "0x4d2570ccB2a6653D62a002027C0d383FfB193A16",
  predictedAddress: "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  params: { offchainId: `0x${"11".repeat(32)}`, beneficiary: OPERATOR, target: "1000000000", deadline: "1800000000", beneficiaryType: 0 },
};
const wallet: WalletLike = { address: OPERATOR, switchChain: async () => undefined, getEthereumProvider: async () => ({}) };

function fakes(options: { prepare?: PostResult<unknown>; linkedAfter?: number; publish?: "sent" | "already" | "reject" | "mismatch"; mined?: boolean; operator?: boolean } = {}) {
  const log: string[] = [];
  let checks = 0;
  const post = (async (url: string, body: unknown) => {
    log.push(`post ${url.replace(/^\/api\/admin\/campaigns\/[^/]+\/publish\//, "")}${body && (body as { txHash?: string }).txHash ? " tx" : ""}`);
    if (url.endsWith("/prepare")) return options.prepare ?? { ok: true, data: CALL };
    if (url.endsWith("/sent")) return { ok: true, data: {} };
    checks++;
    return { ok: true, data: { status: checks >= (options.linkedAfter ?? 1) ? "DEPLOYED" : "APPROVED" } };
  }) as PublishFlowDeps["post"];
  const deps: PublishFlowDeps = {
    wallets: [wallet],
    post,
    pick: async () => {
      log.push("pick");
      return options.operator === false
        ? { chosen: null, checked: [OPERATOR] }
        : { chosen: { provider: {} as EIP1193Provider, account: OPERATOR }, checked: [OPERATOR] };
    },
    publish: async () => {
      log.push("sign");
      if (options.publish === "reject") throw Object.assign(new Error("User rejected"), { code: 4001 });
      if (options.publish === "mismatch") throw new PublishCheckError("prediction_mismatch");
      return options.publish === "already" ? { kind: "already_on_chain", address: CALL.predictedAddress } : { kind: "sent", txHash: TX };
    },
    wait: async () => {
      log.push("wait");
      return options.mined ?? true;
    },
    sleep: async () => undefined,
    linkAttempts: 3,
  };
  return { log, deps };
}

describe("publishFlow", () => {
  it("prepares, finds the operator, signs, records, waits and links — in that order", async () => {
    const { log, deps } = fakes({ linkedAfter: 2 });
    const steps: PublishStep[] = [];
    expect(await publishFlow("c1", { ...deps, onStep: (s) => steps.push(s) })).toEqual({ kind: "deployed" });
    expect(log).toEqual(["post prepare", "pick", "sign", "post sent tx", "wait", "post check", "post check"]);
    expect(steps).toEqual(["preparing", "checking", "signing", "mining", "linking"]);
  });

  it("only links when the contract already exists (no second transaction)", async () => {
    const { log, deps } = fakes({ publish: "already" });
    expect(await publishFlow("c1", deps)).toEqual({ kind: "deployed" });
    expect(log).toEqual(["post prepare", "pick", "sign", "post check"]);
  });

  it("returns the refusals the panel turns into messages", async () => {
    expect(await publishFlow("c1", fakes({ prepare: { ok: false, code: "not_approved" } }).deps)).toEqual({ kind: "prepare_failed", code: "not_approved" });
    expect(await publishFlow("c1", fakes({ operator: false }).deps)).toEqual({ kind: "no_operator_wallet", checked: [OPERATOR] });
    expect(await publishFlow("c1", fakes({ publish: "reject" }).deps)).toEqual({ kind: "rejected_by_user" });
    expect(await publishFlow("c1", fakes({ publish: "mismatch" }).deps)).toEqual({ kind: "check_failed", code: "prediction_mismatch" });
    expect(await publishFlow("c1", fakes({ mined: false }).deps)).toEqual({ kind: "reverted" });
    expect(await publishFlow("c1", fakes({ linkedAfter: 99 }).deps)).toEqual({ kind: "not_linked_yet" });
  });
});

describe("publishBatch", () => {
  const campaigns = [
    { id: "a", title: "A", publishTxHash: null },
    { id: "b", title: "B", publishTxHash: null },
    { id: "c", title: "C", publishTxHash: null },
  ];

  it("finds the operator wallet once and publishes every campaign", async () => {
    const { log, deps } = fakes();
    const flow: typeof publishFlow = (id, d) => publishFlow(id, { ...deps, ...d, post: deps.post, pick: deps.pick, publish: deps.publish, wait: deps.wait, sleep: deps.sleep, linkAttempts: 3 });
    const progress: string[] = [];
    const summary = await publishBatch(campaigns, [wallet], (i, s) => progress.push(`${i}:${s}`), flow);
    expect(summary).toEqual({ deployed: 3, notLinked: 0, failed: [], stopped: null });
    expect(log.filter((l) => l === "pick")).toHaveLength(1);
    expect(log.filter((l) => l === "sign")).toHaveLength(3);
    expect(progress).toContain("2:linking");
  });

  it("stops at a rejected signature and goes on after other failures", async () => {
    const results: Awaited<ReturnType<typeof publishFlow>>[] = [{ kind: "failed" }, { kind: "rejected_by_user" }, { kind: "deployed" }];
    const seen: string[] = [];
    const flow: typeof publishFlow = async (id) => {
      seen.push(id);
      return results.shift()!;
    };
    expect(await publishBatch(campaigns, [wallet], () => undefined, flow)).toEqual({ deployed: 0, notLinked: 0, failed: ["A"], stopped: "rejected_by_user" });
    expect(seen).toEqual(["a", "b"]);
  });
});
