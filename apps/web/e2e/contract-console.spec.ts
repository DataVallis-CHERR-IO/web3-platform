/**
 * Admin → Contracts (TASK-034b, ADR-046): PlatformConfig values in human units,
 * a change scheduled through the timelock and applied after the delay.
 * The wallet is a fake EIP-1193 provider on `window.__cherrioE2eWallet` (honoured
 * only when APP_ENV=local) that answers like PlatformConfig and the OZ
 * TimelockController at the addresses the E2E server is configured with.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { eq, inArray } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionResult, keccak256, toFunctionSelector, toHex, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import { TimelockAbi } from "../src/lib/contracts/timelock";
import { encodeSetter, paramSpec } from "../src/lib/contracts/config-params";
import { E2E_PLATFORM_CONFIG, E2E_TIMELOCK } from "../playwright.env";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

const ADMIN_WALLET = "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

const cfg = (fn: string, result: unknown) =>
  encodeFunctionResult({ abi: PlatformConfigAbi, functionName: fn as never, result: result as never }).slice(2);
const tl = (fn: string, result: unknown) =>
  encodeFunctionResult({ abi: TimelockAbi, functionName: fn as never, result: result as never }).slice(2);

/** eth_call answers by selector (the values on Amoy before ADR-045's change). */
function answers(): Record<string, string> {
  const sel = (sig: string) => toFunctionSelector(sig);
  return {
    [sel("feeBps()")]: cfg("feeBps", 100),
    [sel("successThresholdBps()")]: cfg("successThresholdBps", 1000),
    [sel("voteWindow()")]: cfg("voteWindow", 86_400),
    [sel("quorumBps()")]: cfg("quorumBps", 5000),
    [sel("approvalBps()")]: cfg("approvalBps", 5100),
    [sel("refundSweepDelay()")]: cfg("refundSweepDelay", 15_552_000),
    [sel("minDonation()")]: cfg("minDonation", 1_000_000n),
    [sel("releaseDelay()")]: cfg("releaseDelay", 259_200),
    [sel("treasury()")]: cfg("treasury", ADMIN_WALLET),
    [sel("emergencyPool()")]: cfg("emergencyPool", "0xFa7Fd0253813E196d74575A8F93ABB91cd009517"),
    [sel("OPERATOR_ROLE()")]: cfg("OPERATOR_ROLE", keccak256(toHex("OPERATOR_ROLE"))),
    [sel("GUARDIAN_ROLE()")]: cfg("GUARDIAN_ROLE", keccak256(toHex("GUARDIAN_ROLE"))),
    [sel("PROPOSER_ROLE()")]: tl("PROPOSER_ROLE", keccak256(toHex("PROPOSER_ROLE"))),
    [sel("EXECUTOR_ROLE()")]: tl("EXECUTOR_ROLE", keccak256(toHex("EXECUTOR_ROLE"))),
    [sel("CANCELLER_ROLE()")]: tl("CANCELLER_ROLE", keccak256(toHex("CANCELLER_ROLE"))),
    [sel("hasRole(bytes32,address)")]: cfg("hasRole", true),
    [sel("getMinDelay()")]: tl("getMinDelay", 300n),
    [sel("getTimestamp(bytes32)")]: tl("getTimestamp", 1_791_100_000n),
  };
}

async function installWallet(page: Page) {
  const stateSel = toFunctionSelector("getOperationState(bytes32)");
  const waiting = tl("getOperationState", 1);
  const ready = tl("getOperationState", 2);
  await page.addInitScript(
    ({ address, answers, stateSel, waiting, ready }) => {
      const zero32 = `0x${"00".repeat(32)}`;
      const win = window as unknown as { __sent: string[]; __opState: string; __cherrioE2eWallet: unknown };
      win.__sent = [];
      // The timelock answers "ready" once the test said so (survives a reload).
      win.__opState = sessionStorage.getItem("e2eOpReady") ? ready : waiting;
      win.__cherrioE2eWallet = {
        address,
        provider: {
          async request({ method, params }: { method: string; params?: unknown[] }) {
            switch (method) {
              case "eth_chainId":
                return "0x7a69"; // 31337, the local chain of APP_ENV=local
              case "eth_accounts":
              case "eth_requestAccounts":
                return [address];
              case "eth_call": {
                const { data } = params![0] as { data: string };
                const selector = data.slice(0, 10);
                if (selector === stateSel) return `0x${win.__opState}`;
                const answer = answers[selector];
                if (!answer) throw new Error(`unexpected eth_call ${selector}`);
                return `0x${answer}`;
              }
              case "eth_sendTransaction":
                win.__sent.push((params![0] as { data: string }).data);
                return `0x${String(win.__sent.length).padStart(2, "0").repeat(32)}`;
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
              case "eth_maxPriorityFeePerGas":
                return "0x59682f00";
              case "eth_blockNumber":
                return "0x10";
              case "eth_getTransactionByHash":
                return null;
              default:
                throw new Error(`unexpected ${method}`);
            }
          },
        },
      };
    },
    { address: ADMIN_WALLET, answers: answers(), stateSel, waiting, ready }
  );
  return {
    /** From now on the operation is ready; reloads the page so it reads the new state. */
    ready: async () => {
      await page.evaluate(() => sessionStorage.setItem("e2eOpReady", "1"));
      await page.reload();
    },
  };
}

async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => decodeFunctionData({ abi: TimelockAbi, data: d as Hex }));
}

test.describe("Admin → Contracts", () => {
  const users: string[] = [];
  test.afterAll(async () => {
    const client = db();
    try {
      if (users.length > 0) {
        const rows = await client.select({ id: schema.contractChanges.id }).from(schema.contractChanges)
          .where(inArray(schema.contractChanges.scheduledBy, users));
        const ids = rows.map((r) => r.id);
        if (ids.length > 0) {
          await client.delete(schema.auditLog).where(inArray(schema.auditLog.entityId, ids));
          await client.delete(schema.contractChanges).where(inArray(schema.contractChanges.id, ids));
        }
      }
    } finally {
      await client.$client.end();
    }
    for (const id of users) await deleteTestUser(id);
  });

  test("is hidden from non-admins", async ({ page, context }) => {
    users.push(await loginAsNewUser(context, "console-user"));
    const res = await page.goto("/en/admin/contracts");
    expect(res?.status()).toBe(404);
  });

  test("shows values in human units, schedules a change through the timelock and applies it", async ({ page, context }, info) => {
    const adminId = await loginAsNewUser(context, `console-admin-${info.project.name}`, { admin: true });
    users.push(adminId);
    const wallet = await installWallet(page);
    await page.goto("/en/admin/contracts");

    await expect(page.getByRole("heading", { name: "Contracts", level: 1 })).toBeVisible();
    await expect(page.getByText("5 minutes", { exact: true })).toBeVisible(); // timelock delay, not "300"
    const voteWindow = page.getByLabel("Vote window", { exact: true });
    await expect(voteWindow).toHaveValue("1");
    await expect(page.getByLabel("Unit for Vote window")).toHaveValue("days");
    await expect(page.getByLabel("Quorum", { exact: true })).toHaveValue("50");
    await expect(page.getByLabel("Minimum donation", { exact: true })).toHaveValue("1");

    // Out of the contract's bounds → a readable error, nothing to review.
    await voteWindow.fill("15");
    await expect(page.getByText("The highest allowed value is 14 days.")).toBeVisible();
    await expect(page.getByRole("button", { name: "No changes" })).toBeDisabled();

    // 1 hour vote window and 25 % quorum (ADR-045 testing setup on Amoy).
    await voteWindow.fill("1");
    await page.getByLabel("Unit for Vote window").selectOption("hours");
    await page.getByLabel("Quorum", { exact: true }).fill("25");
    await page.getByRole("button", { name: "Review 2 changes" }).click();
    const review = page.getByRole("region", { name: "Changes to schedule" }).first();
    await expect(review.getByRole("row", { name: /Vote window/ })).toContainText("1 day");
    await expect(review.getByRole("row", { name: /Vote window/ })).toContainText("1 hour");
    await expect(review.getByRole("row", { name: /Quorum/ })).toContainText("25%");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);

    await page.getByRole("button", { name: "Schedule the change" }).click();
    await expect(page.getByText("The change is scheduled.")).toBeVisible();

    const [scheduled] = await sentCalls(page);
    expect(scheduled!.functionName).toBe("scheduleBatch");
    const [targets, values, payloads, predecessor, , delay] = scheduled!.args as [string[], bigint[], Hex[], Hex, Hex, bigint];
    expect(targets).toEqual([E2E_PLATFORM_CONFIG, E2E_PLATFORM_CONFIG]);
    expect(values).toEqual([0n, 0n]);
    expect(payloads).toEqual([encodeSetter(paramSpec("voteWindow"), 3600n), encodeSetter(paramSpec("quorumBps"), 2500n)]);
    expect(predecessor).toBe(`0x${"0".repeat(64)}`);
    expect(delay).toBe(300n);

    const client = db();
    try {
      const [row] = await client.select().from(schema.contractChanges).where(eq(schema.contractChanges.scheduledBy, adminId));
      expect(row?.timelock).toBe(E2E_TIMELOCK.toLowerCase());
      expect(row?.summary).toEqual([
        { key: "voteWindow", from: "86400", to: "3600" },
        { key: "quorumBps", from: "5000", to: "2500" },
      ]);

      // Waiting → the apply button stays off; ready → apply with the same arguments.
      await expect(page.getByText(/^Waiting — can be applied from/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Apply the change" })).toBeDisabled();
      await wallet.ready();
      await expect(page.getByText("Ready to apply")).toBeVisible();
      await page.getByRole("button", { name: "Apply the change" }).click();
      await expect(page.getByText("The change is applied.")).toBeVisible();

      const calls = await sentCalls(page);
      const executed = calls.at(-1)!;
      expect(executed.functionName).toBe("executeBatch");
      expect((executed.args as readonly unknown[]).slice(0, 4)).toEqual([targets, values, payloads, predecessor]);
      expect((executed.args as readonly unknown[])[4]).toBe((scheduled!.args as readonly unknown[])[4]); // same salt

      const [after] = await client.select().from(schema.contractChanges).where(eq(schema.contractChanges.id, row!.id));
      expect(after?.executedBy).toBe(adminId);
    } finally {
      await client.$client.end();
    }
  });
});
