/**
 * apps/agents/src/guard.ts
 * The agents work on dev only (ADR-063 §1): the public testnet on Polygon
 * Amoy. Every entry point calls assertTestnet before it does anything, and the
 * wallet bridge checks the chain again on every signature.
 */
import { AMOY_CHAIN_ID } from "@cherrio/shared/chains";

export const TESTNET_ORIGIN = "https://testnet.cherr.io";
export const TESTNET_HOST = "testnet.cherr.io";
export const TESTNET_CHAIN_ID = AMOY_CHAIN_ID;

export class GuardError extends Error {}

export function assertTestnet(target: { origin: string; chainId: number }): void {
  let origin: string;
  try {
    origin = new URL(target.origin).origin;
  } catch {
    throw new GuardError(`not a URL: ${target.origin}`);
  }
  if (origin !== TESTNET_ORIGIN) {
    throw new GuardError(`agents run on ${TESTNET_ORIGIN} only, not on ${origin}`);
  }
  if (target.chainId !== TESTNET_CHAIN_ID) {
    throw new GuardError(`agents run on chain ${TESTNET_CHAIN_ID} only, not on ${target.chainId}`);
  }
}
