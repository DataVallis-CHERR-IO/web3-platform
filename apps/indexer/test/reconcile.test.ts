import { describe, it, expect } from "vitest";
import { checkpointBlock } from "../lib/reconcile";

// A Ponder 0.17 checkpoint is 75 decimal digits. The scenario test additionally
// checks the decoded block against Ponder's own /status, which is what fails
// first if a Ponder upgrade changes the format.
const SAMPLE =
  "1790839517" + // block timestamp (10)
  "0000000000080002" + // chain id (16)
  "0000000049017092" + // block number (16)
  "0000000000000003" + // transaction index (16)
  "5" + // event type (1)
  "0000000000000007"; // event index (16)

describe("checkpointBlock", () => {
  it("reads the block number from a Ponder 0.17 checkpoint", () => {
    expect(SAMPLE).toHaveLength(75);
    expect(checkpointBlock(SAMPLE)).toBe(49017092n);
  });

  it("rejects any other shape instead of returning a wrong block", () => {
    expect(() => checkpointBlock(SAMPLE.slice(1))).toThrow("Unexpected Ponder checkpoint format");
    expect(() => checkpointBlock(`${SAMPLE}0`)).toThrow("Unexpected Ponder checkpoint format");
    expect(() => checkpointBlock(`0x${SAMPLE.slice(2)}`)).toThrow("Unexpected Ponder checkpoint format");
    expect(() => checkpointBlock("")).toThrow("Unexpected Ponder checkpoint format");
  });
});
