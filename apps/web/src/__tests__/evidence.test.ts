import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildManifest, manifestHash, openRound } from "@/lib/campaigns/evidence";
import type { CampaignLifecycle } from "@/lib/campaigns/lifecycle";

// TASK-033c / ADR-047: the evidence manifest is canonical, so anyone can rebuild
// it from the files and the note and compare its SHA-256 with the chain.

const A = "a".repeat(64);
const B = "b".repeat(64);
const input = {
  chainId: 80002,
  campaign: "0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED",
  round: 1,
  note: "Paid the vet — invoices attached.",
  files: [
    { sha256: B, size: 2048, type: "image/webp", visibility: "PUBLIC" as const },
    { sha256: A, size: 1024, type: "application/pdf", visibility: "PRIVATE" as const },
  ],
};

describe("evidence manifest", () => {
  it("is exact: fixed keys, lowercase campaign, files sorted by hash, no whitespace", () => {
    expect(buildManifest(input)).toBe(
      '{"schema":"cherrio.evidence/1","chainId":80002,"campaign":"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed","round":1,' +
        '"note":"Paid the vet — invoices attached.","files":[' +
        `{"sha256":"${A}","size":1024,"type":"application/pdf","visibility":"private"},` +
        `{"sha256":"${B}","size":2048,"type":"image/webp","visibility":"public"}]}`
    );
  });

  it("does not depend on upload order", () => {
    expect(buildManifest({ ...input, files: [...input.files].reverse() })).toBe(buildManifest(input));
  });

  it("changes with every field that matters", () => {
    const base = buildManifest(input);
    expect(buildManifest({ ...input, round: 0 })).not.toBe(base);
    expect(buildManifest({ ...input, note: "" })).not.toBe(base);
    expect(buildManifest({ ...input, chainId: 137 })).not.toBe(base);
    expect(buildManifest({ ...input, files: input.files.slice(1) })).not.toBe(base);
  });

  it("bundleHash is the SHA-256 of the manifest's UTF-8 bytes as bytes32", () => {
    const m = buildManifest(input);
    const h = manifestHash(m);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).toBe(`0x${createHash("sha256").update(Buffer.from(m, "utf8")).digest("hex")}`);
  });
});

describe("openRound", () => {
  const lc = (over: Partial<CampaignLifecycle>) => ({ state: "PAYING", payoutMode: 1, tranchesReleased: 1, ...over }) as CampaignLifecycle;
  it("round 0 after payment 1 and round 1 after payment 2, milestones only", () => {
    expect(openRound(lc({}))).toBe(0);
    expect(openRound(lc({ tranchesReleased: 2 }))).toBe(1);
  });
  it("nothing open otherwise", () => {
    expect(openRound(lc({ tranchesReleased: 3 }))).toBeNull();
    expect(openRound(lc({ payoutMode: 0 }))).toBeNull();
    for (const state of ["LIVE", "SUCCEEDED", "VOTING", "NEEDS_REVIEW", "COMPLETED", "REJECTED", "FROZEN"] as const) {
      expect(openRound(lc({ state }))).toBeNull();
    }
  });
});
