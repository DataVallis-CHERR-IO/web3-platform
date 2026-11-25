import { describe, expect, it } from "vitest";
import { AGENT_CREW, agentCrewEnabled, agentDisplayName, crewMemberFor } from "../src/agent-crew.js";

describe("agent crew registry (TASK-061c)", () => {
  it("lists nine members by HD index 0–8 with unique lower-case addresses", () => {
    expect(AGENT_CREW.map((m) => m.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const m of AGENT_CREW) expect(m.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(new Set(AGENT_CREW.map((m) => m.address)).size).toBe(AGENT_CREW.length);
    expect(new Set(AGENT_CREW.map((m) => m.name)).size).toBe(AGENT_CREW.length);
  });

  it("exists only on dev and local", () => {
    expect(agentCrewEnabled("dev")).toBe(true);
    expect(agentCrewEnabled("local")).toBe(true);
    for (const env of ["uat", "prod", "", undefined]) expect(agentCrewEnabled(env)).toBe(false);
  });

  it("finds a member by any of the addresses, case-insensitively", () => {
    const donor = AGENT_CREW[4]!;
    const mixed = donor.address.replace("0x", "0X").toUpperCase().replace("0X", "0x");
    expect(crewMemberFor(["0x0000000000000000000000000000000000000001", mixed], "dev")).toEqual(donor);
    expect(agentDisplayName(donor)).toBe("Agent donor-1");
  });

  it("never marks anyone on uat or prod, and not strangers on dev", () => {
    const staff = AGENT_CREW[1]!.address;
    expect(crewMemberFor([staff], "prod")).toBeNull();
    expect(crewMemberFor([staff], "uat")).toBeNull();
    expect(crewMemberFor(["0x0000000000000000000000000000000000000001"], "dev")).toBeNull();
    expect(crewMemberFor([], "dev")).toBeNull();
  });
});
