/**
 * apps/agents/src/crew.ts
 * The crew (TASK-061, ADR-063): who the agents are and which wallet each one
 * uses. Every wallet comes from ONE mnemonic by HD index, so the list of
 * public addresses is stable and can be committed, while the mnemonic lives
 * only in a GitHub secret. Nothing here ever returns or prints the mnemonic.
 */
import { mnemonicToAccount, type HDAccount } from "viem/accounts";
import { AGENT_CREW, type CrewPersona } from "@cherrio/shared/agent-crew";

export type Persona = CrewPersona;

export interface CrewSpec {
  /** HD address index (m/44'/60'/0'/0/<index>). Never reuse or reorder. */
  index: number;
  name: string;
  persona: Persona;
}

/**
 * Order is part of the contract: an index always means the same agent. The
 * names, personas and public addresses live in `@cherrio/shared/agent-crew`
 * (TASK-061c), so the web app marks exactly these wallets as agents.
 */
export const CREW: readonly CrewSpec[] = AGENT_CREW.map(({ index, name, persona }) => ({ index, name, persona }));

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

/**
 * TASK-061c: the derived wallets must be exactly the public registry, or the web
 * app would not mark them as agents (their campaigns would look real). A changed
 * mnemonic stops the run; the CLI `addresses` still works to print the new list.
 */
export function assertCrewMatchesRegistry(crew: readonly CrewMember[], registry = AGENT_CREW): void {
  const wrong = crew.filter((m) => registry.find((r) => r.index === m.index)?.address !== m.address);
  if (wrong.length > 0 || crew.length !== registry.length) {
    throw new Error(
      `crew wallets do not match @cherrio/shared/agent-crew (${wrong.map((m) => m.name).join(", ") || "count"}): ` +
        "update the registry with the public addresses from `pnpm --filter agents addresses`"
    );
  }
}
