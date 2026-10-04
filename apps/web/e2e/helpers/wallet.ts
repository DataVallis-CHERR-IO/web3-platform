/**
 * apps/web/e2e/helpers/wallet.ts
 * The E2E wallet (`window.__cherrioE2eWallet`, honoured only with APP_ENV=local):
 * every simulation succeeds; sent calldata is recorded in `window.__sent`.
 * Shared by the lifecycle (TASK-033b) and evidence (TASK-033c) specs.
 */
import type { Page } from "@playwright/test";
import { decodeFunctionData, type Hex } from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";

/** A wallet whose simulations all succeed; records sent calldata in window.__sent. */
export async function installWallet(page: Page, address: string) {
  await page.addInitScript((a: string) => {
    const zero32 = `0x${"00".repeat(32)}`;
    const win = window as unknown as { __sent: string[]; __cherrioE2eWallet: unknown };
    win.__sent = [];
    win.__cherrioE2eWallet = {
      address: a,
      provider: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_chainId": return "0x7a69";
            case "eth_accounts": case "eth_requestAccounts": return [a];
            case "eth_call": return "0x";
            case "eth_estimateGas": return "0x5208";
            case "eth_sendTransaction":
              win.__sent.push((params![0] as { data: string }).data);
              return `0x${"cd".repeat(32)}`;
            case "eth_getTransactionReceipt":
              return {
                transactionHash: (params as string[])[0], status: "0x1", blockNumber: "0x10", blockHash: zero32,
                transactionIndex: "0x0", from: a, to: a, cumulativeGasUsed: "0x1", gasUsed: "0x1",
                effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null,
              };
            case "eth_getBlockByNumber":
              return {
                number: "0x10", hash: zero32, parentHash: zero32, timestamp: "0x6a0f0000", baseFeePerGas: "0x9502f9000",
                gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], nonce: "0x0000000000000000",
                difficulty: "0x0", logsBloom: `0x${"00".repeat(256)}`, miner: `0x${"00".repeat(20)}`, extraData: "0x",
                size: "0x1", stateRoot: zero32, receiptsRoot: zero32, transactionsRoot: zero32, sha3Uncles: zero32, mixHash: zero32,
              };
            case "eth_maxPriorityFeePerGas": return "0x59682f00";
            case "eth_blockNumber": return "0x10";
            case "eth_getTransactionByHash": return null;
            default: throw new Error(`unexpected ${method}`);
          }
        },
      },
    };
  }, address);
}

export async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => {
    const call = decodeFunctionData({ abi: CampaignAbi, data: d as Hex });
    return { fn: call.functionName, args: call.args ?? [] };
  });
}
