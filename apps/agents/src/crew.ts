/**
 * apps/agents/src/crew.ts
 * The crew (TASK-061, ADR-063): who the agents are and which wallet each one
 * uses. Every wallet comes from ONE mnemonic by HD index, so the list of
 * public addresses is stable and can be committed, while the mnemonic lives
 * only in a GitHub secret. Nothing here ever returns or prints the mnemonic.
 */
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

export type Persona = "treasury" | "staff" | "fundraiser" | "donor" | "pool" | "awkward";

export interface CrewSpec {
  /** HD address index (m/44'/60'/0'/0/<index>). Never reuse or reorder. */
  index: number;
  name: string;
  persona: Persona;
}

/** Order is part of the contract: an index always means the same agent. */
export const CREW: readonly CrewSpec[] = [
  { index: 0, name: "treasury", persona: "treasury" },
  { index: 1, name: "staff", persona: "staff" },
  { index: 2, name: "fundraiser-1", persona: "fundraiser" },
  { index: 3, name: "fundraiser-2", persona: "fundraiser" },
  { index: 4, name: "donor-1", persona: "donor" },
  { index: 5, name: "donor-2", persona: "donor" },
  { index: 6, name: "donor-3", persona: "donor" },
  { index: 7, name: "pool-1", persona: "pool" },
  { index: 8, name: "awkward-1", persona: "awkward" },
];

export interface CrewMember extends CrewSpec {
  account: HDAccount;
  /** Lower-case, like every hex column in the database. */
  address: `0x${string}`;
}

export function deriveCrew(mnemonic: string): CrewMember[] {
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 12 && words.length !== 24) {
    // Do not echo the value: a wrong secret must not land in a log.
    throw new Error("AGENT_MNEMONIC must be a 12- or 24-word phrase");
  }
  return CREW.map((spec) => {
    const account = mnemonicToAccount(words.join(" "), { addressIndex: spec.index });
    return { ...spec, account, address: account.address.toLowerCase() as `0x${string}` };
  });
}

export function member(crew: CrewMember[], name: string): CrewMember {
  const found = crew.find((m) => m.name === name);
  if (!found) throw new Error(`unknown crew member: ${name}`);
  return found;
}
