/**
 * packages/shared/src/agent-crew.ts
 * The public registry of the testnet agents' wallets (TASK-061c, ADR-063).
 *
 * Every crew wallet comes from one mnemonic by HD index (apps/agents/src/crew.ts);
 * only the PUBLIC addresses are listed here, so the web app, the worker and the
 * runner agree on who is an agent without any secret. The runner checks at start
 * that the addresses it derives are exactly these (a changed mnemonic stops it).
 *
 * The registry only means something on the testnet (dev) and locally: on uat and
 * prod `crewMemberFor` returns null, so nobody is ever marked as an agent there.
 */

/** `redteam` (TASK-061f): submits deliberately shady campaigns the staff agent must catch. */
export type CrewPersona = "treasury" | "staff" | "fundraiser" | "donor" | "pool" | "awkward" | "redteam";

export interface CrewEntry {
  /** HD address index (m/44'/60'/0'/0/<index>). Never reuse or reorder. */
  readonly index: number;
  readonly name: string;
  readonly persona: CrewPersona;
  /** Lower-case, like every hex column in the database. */
  readonly address: `0x${string}`;
}

/** Order is part of the contract: an index always means the same agent. */
export const AGENT_CREW: readonly CrewEntry[] = [
  { index: 0, name: "treasury", persona: "treasury", address: "0x4d414eaeae80259e3e84c0059a1929f2bc703018" },
  { index: 1, name: "staff", persona: "staff", address: "0x31e76078393e4d8a7e9209482f6c7319a0e93e28" },
  { index: 2, name: "fundraiser-1", persona: "fundraiser", address: "0xa8fa68f0f6e06c3e8d5b6328269ae68ba5e34d48" },
  { index: 3, name: "fundraiser-2", persona: "fundraiser", address: "0x2b4c1c72a9ec86042538ecf3df01b8807d99f7e5" },
  { index: 4, name: "donor-1", persona: "donor", address: "0x663911aae7ac357ed7c7d3cb9dc82770eabcce4d" },
  { index: 5, name: "donor-2", persona: "donor", address: "0x2d8aeed91824ba23de9589d94fc9d20bc102584a" },
  { index: 6, name: "donor-3", persona: "donor", address: "0x474cbcd7d377b0b2518bb0ba004db16443c6f8a8" },
  { index: 7, name: "pool-1", persona: "pool", address: "0x65bedf3982206e7d61948730a57d0107e338ee6b" },
  { index: 8, name: "awkward-1", persona: "awkward", address: "0xb696a0d49a0e5a52f22b62ff5d2cdac8e8c49c7d" },
  // Added 2026-11-27 (David ran `pnpm --filter agents addresses --index 9`).
  { index: 9, name: "scammer-1", persona: "redteam", address: "0x0e9cab8003981f8fb07a608e7b2d8d037370d83b" },
];

/** Environments where the crew exists. Never uat or prod. */
export const AGENT_CREW_ENVS: readonly string[] = ["local", "dev"];

export function agentCrewEnabled(appEnv: string | undefined): boolean {
  return appEnv !== undefined && AGENT_CREW_ENVS.includes(appEnv);
}

/** The crew member owning one of these addresses, or null (always null outside dev/local). */
export function crewMemberFor(addresses: readonly string[], appEnv: string | undefined): CrewEntry | null {
  if (!agentCrewEnabled(appEnv)) return null;
  for (const a of addresses) {
    const lower = a.toLowerCase();
    const found = AGENT_CREW.find((m) => m.address === lower);
    if (found) return found;
  }
  return null;
}

/**
 * TASK-061f: the staff agent rejects every red-team campaign with one of these notes;
 * /en/agents counts them by prefix. One definition for the runner and the web app.
 */
export const RED_TEAM_CAUGHT = "red team: caught";
export const RED_TEAM_MISSED = "red team: missed";

/** The red team's wallets (lower-case). Empty outside dev/local, like every crew lookup. */
export function redTeamAddresses(appEnv: string | undefined, registry: readonly CrewEntry[] = AGENT_CREW): string[] {
  if (!agentCrewEnabled(appEnv)) return [];
  return registry.filter((m) => m.persona === "redteam").map((m) => m.address);
}

/** Public display name of an agent user, e.g. "Agent donor-1". */
export function agentDisplayName(entry: CrewEntry): string {
  return `Agent ${entry.name}`;
}
