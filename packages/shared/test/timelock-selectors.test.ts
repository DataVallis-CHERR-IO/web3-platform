import { describe, expect, it } from "vitest";
import { toFunctionSelector, type AbiFunction } from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import { MONEY_SELECTORS, ROLE_SELECTORS, SETTING_SELECTORS } from "../src/timelock-selectors";

// TASK-023d: the timelock watcher's selector lists match the PlatformConfig ABI.
const fns = PlatformConfigAbi.filter((i): i is AbiFunction => i.type === "function") as AbiFunction[];
const of = (name: string) => toFunctionSelector(fns.find((f) => f.name === name)!);

describe("timelock watcher selectors", () => {
  it("money = setEmergencyPool + setTreasury", () => {
    expect([...MONEY_SELECTORS]).toEqual([of("setEmergencyPool"), of("setTreasury")]);
  });
  it("roles = grantRole, revokeRole, renounceRole, the timelock's updateDelay", () => {
    expect([...ROLE_SELECTORS]).toEqual([of("grantRole"), of("revokeRole"), of("renounceRole"), toFunctionSelector("updateDelay(uint256)")]);
  });
  it("settings = every other PlatformConfig setter, none missing", () => {
    const setters = fns.filter((f) => f.name.startsWith("set") && !["setEmergencyPool", "setTreasury"].includes(f.name));
    expect([...SETTING_SELECTORS].sort()).toEqual(setters.map((f) => toFunctionSelector(f)).sort());
  });
});
