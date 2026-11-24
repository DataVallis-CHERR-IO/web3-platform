/**
 * apps/agents/src/funding.ts
 * Top-up plan: the treasury keeps every working wallet above a floor of POL
 * (gas) and test USDC. Pure arithmetic on bigint — the CLI reads balances and
 * sends what this returns. If the treasury cannot cover the plan, nothing is
 * sent and the shortfall is reported (David refills the treasury).
 */
export interface Balance { name: string; address: `0x${string}`; pol: bigint; usdc: bigint }

export interface Levels {
  /** Top up when below `min`, up to `target`. Wei / USDC units (6 decimals). */
  pol: { min: bigint; target: bigint };
  usdc: { min: bigint; target: bigint };
  /** POL the treasury keeps for its own gas. */
  treasuryReservePol: bigint;
}

export interface Transfer { to: `0x${string}`; name: string; asset: "POL" | "USDC"; amount: bigint }

export interface Plan {
  transfers: Transfer[];
  total: { pol: bigint; usdc: bigint };
  shortfall: { pol: bigint; usdc: bigint };
  ok: boolean;
}

export const DEFAULT_LEVELS: Levels = {
  pol: { min: 50_000_000_000_000_000n, target: 200_000_000_000_000_000n }, // 0.05 → 0.2 POL
  usdc: { min: 10_000_000n, target: 40_000_000n }, // 10 → 40 USDC
  treasuryReservePol: 100_000_000_000_000_000n, // 0.1 POL
};

/** Personas that spend USDC; the others need gas only. */
const SPENDS_USDC = /^(donor|pool|awkward)/;

export function planTopUps(treasury: Balance, others: Balance[], levels: Levels = DEFAULT_LEVELS): Plan {
  const transfers: Transfer[] = [];
  let pol = 0n;
  let usdc = 0n;
  for (const w of others) {
    if (w.pol < levels.pol.min) {
      const amount = levels.pol.target - w.pol;
      transfers.push({ to: w.address, name: w.name, asset: "POL", amount });
      pol += amount;
    }
    if (SPENDS_USDC.test(w.name) && w.usdc < levels.usdc.min) {
      const amount = levels.usdc.target - w.usdc;
      transfers.push({ to: w.address, name: w.name, asset: "USDC", amount });
      usdc += amount;
    }
  }
  const polAvailable = treasury.pol > levels.treasuryReservePol ? treasury.pol - levels.treasuryReservePol : 0n;
  const shortfall = {
    pol: pol > polAvailable ? pol - polAvailable : 0n,
    usdc: usdc > treasury.usdc ? usdc - treasury.usdc : 0n,
  };
  return { transfers, total: { pol, usdc }, shortfall, ok: shortfall.pol === 0n && shortfall.usdc === 0n };
}
