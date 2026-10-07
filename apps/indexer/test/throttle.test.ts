import { describe, expect, it } from "vitest";
import { custom, type Transport } from "viem";
import { creditCost, creditPacer, fallbackCreditsPerSecond, paced, type Clock } from "../lib/throttle";

/** A clock that only moves when someone sleeps. */
function fakeClock(): Clock & { t: number } {
  const clock = {
    t: 0,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

describe("creditPacer", () => {
  it("lets three eth_getLogs (255 credits) through at 400 credits/s spaced, in order", async () => {
    const clock = fakeClock();
    const acquire = creditPacer(400, clock);
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(() => acquire(creditCost("eth_getLogs")).then(() => starts.push(clock.t))));
    // Full bucket (400): first at 0 (145 left); second needs 110 more → 275 ms; third needs 255 → +638 ms.
    expect(starts).toEqual([0, 275, 913]);
  });

  it("does not wait while the bucket holds enough, and refills with time", async () => {
    const clock = fakeClock();
    const acquire = creditPacer(400, clock);
    await acquire(80);
    await acquire(80);
    await acquire(80);
    expect(clock.t).toBe(0);
    clock.t += 1000; // a quiet second refills the bucket
    await acquire(255);
    expect(clock.t).toBe(1000);
  });

  it("a request dearer than the bucket waits for a full bucket instead of forever", async () => {
    const clock = fakeClock();
    const acquire = creditPacer(100, clock);
    await acquire(50);
    await acquire(255);
    expect(clock.t).toBe(500);
  });
});

describe("paced transport", () => {
  it("passes every request through, paced, and shares one bucket between clients", async () => {
    const clock = fakeClock();
    const seen: { method: string; at: number }[] = [];
    const inner: Transport = custom({
      request: async ({ method }: { method: string }) => {
        seen.push({ method, at: clock.t });
        return "0x1";
      },
    });
    const transport = paced(inner, 400, clock);
    const a = transport({ retryCount: 0 });
    const b = transport({ retryCount: 0 });
    const results = await Promise.all([
      a.request({ method: "eth_getLogs" }),
      b.request({ method: "eth_getLogs" }),
      a.request({ method: "eth_chainId" }),
    ]);
    expect(results).toEqual(["0x1", "0x1", "0x1"]);
    expect(seen).toEqual([
      { method: "eth_getLogs", at: 0 },
      { method: "eth_getLogs", at: 275 },
      { method: "eth_chainId", at: 288 },
    ]);
  });
});

describe("INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND", () => {
  it("defaults to 400, accepts 0 (off) and refuses nonsense", () => {
    expect(fallbackCreditsPerSecond({})).toBe(400);
    expect(fallbackCreditsPerSecond({ INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND: "0" })).toBe(0);
    expect(fallbackCreditsPerSecond({ INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND: "250" })).toBe(250);
    expect(() => fallbackCreditsPerSecond({ INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND: "-1" })).toThrow();
    expect(() => fallbackCreditsPerSecond({ INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND: "fast" })).toThrow();
  });
});
