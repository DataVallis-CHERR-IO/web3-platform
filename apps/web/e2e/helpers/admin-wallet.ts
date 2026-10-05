import type { Page } from "@playwright/test";
import { encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Hex } from "viem";

// Fake admin wallet for E2E (APP_ENV=local only): answers PlatformConfig /
// timelock role reads by selector, accepts every other simulation ("0x"),
// records sent calldata in `window.__sent`. Shared by guardian.spec.ts
// (TASK-033d) and admin-emergency-pool.spec.ts (TASK-046).

export const ADMIN_WALLET = "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7";

/** Role reads answer by selector; `hasRole(role, account)` is true for the roles in `held`. */
export async function installAdminWallet(page: Page, held: string[]) {
  const word = (v: Hex) => encodeAbiParameters([{ type: "bytes32" }], [v]);
  const roles = Object.fromEntries(
    ["OPERATOR_ROLE", "GUARDIAN_ROLE", "PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE"].map((name) => [
      toFunctionSelector(`${name}()`), keccak256(toHex(name)),
    ])
  );
  const heldHashes = held.map((name) => keccak256(toHex(name)).slice(2));
  await page.addInitScript(
    ({ address, roles, heldHashes, hasRole, trueWord, falseWord, words }) => {
      const zero32 = `0x${"00".repeat(32)}`;
      const win = window as unknown as { __sent: string[]; __cherrioE2eWallet: unknown };
      win.__sent = [];
      win.__cherrioE2eWallet = {
        address,
        provider: {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            switch (method) {
              case "eth_chainId": return "0x7a69";
              case "eth_accounts": case "eth_requestAccounts": return [address];
              case "eth_call": {
                const { data } = params![0] as { data: string };
                const selector = data.slice(0, 10);
                if (roles[selector]) return words[selector];
                if (selector === hasRole) return heldHashes.includes(data.slice(10, 74)) ? trueWord : falseWord;
                return "0x"; // every Campaign simulation succeeds
              }
              case "eth_estimateGas": return "0x5208";
              case "eth_sendTransaction":
                win.__sent.push((params![0] as { data: string }).data);
                return `0x${"cd".repeat(32)}`;
              case "eth_getTransactionReceipt":
                return {
                  transactionHash: (params as string[])[0], status: "0x1", blockNumber: "0x10", blockHash: zero32,
                  transactionIndex: "0x0", from: address, to: address, cumulativeGasUsed: "0x1", gasUsed: "0x1",
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
    },
    {
      address: ADMIN_WALLET,
      roles,
      heldHashes,
      hasRole: toFunctionSelector("hasRole(bytes32,address)"),
      trueWord: encodeAbiParameters([{ type: "bool" }], [true]),
      falseWord: encodeAbiParameters([{ type: "bool" }], [false]),
      words: Object.fromEntries(Object.entries(roles).map(([sel, v]) => [sel, word(v as Hex)])),
    }
  );
}

