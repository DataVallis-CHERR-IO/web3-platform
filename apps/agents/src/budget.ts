/**
 * apps/agents/src/budget.ts
 * Hard caps for one run (ADR-063): when a cap is reached the run stops and
 * says which one. Spending is counted before the action, so a cap is never
 * passed by one.
 */
export type Meter = "llmTokens" | "transactions" | "campaigns" | "organisations";

export const DEFAULT_CAPS: Record<Meter, number> = {
  llmTokens: 2_000_000,
  transactions: 60,
  campaigns: 3,
  organisations: 1,
};

export class BudgetExceeded extends Error {
  constructor(public meter: Meter, public cap: number) {
    super(`budget reached: ${meter} (cap ${cap})`);
  }
}

export function createBudget(caps: Record<Meter, number> = DEFAULT_CAPS) {
  const used: Record<Meter, number> = { llmTokens: 0, transactions: 0, campaigns: 0, organisations: 0 };
  return {
    /** Throws BudgetExceeded when `amount` would pass the cap; otherwise counts it. */
    spend(meter: Meter, amount = 1): void {
      if (!Number.isInteger(amount) || amount < 0) throw new Error(`invalid amount for ${meter}`);
      if (used[meter] + amount > caps[meter]) throw new BudgetExceeded(meter, caps[meter]);
      used[meter] += amount;
    },
    used: () => ({ ...used }),
  };
}
