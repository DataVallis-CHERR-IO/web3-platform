import { concatHex, getAddress, getContractAddress, type Address, type Hex } from "viem";

// Predicted address of a campaign clone (ADR-035, TASK-010c).
// CampaignFactory.createCampaign deploys an EIP-1167 minimal proxy with
// Clones.cloneDeterministic(campaignImplementation, offchainId), so the address
// is CREATE2(factory, salt = offchainId, init code = EIP-1167 bytecode for the
// implementation) — the same as CampaignFactory.predictCampaignAddress.

const EIP1167_PREFIX: Hex = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const EIP1167_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3";

/** `offchainId` must be 32 bytes as 0x + 64 hex. Returns the checksummed address. */
export function predictCampaignAddress(factory: Address, implementation: Address, offchainId: Hex): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(offchainId)) throw new Error("offchainId must be 32 bytes (0x + 64 hex)");
  const bytecode = concatHex([EIP1167_PREFIX, getAddress(implementation).toLowerCase() as Hex, EIP1167_SUFFIX]);
  return getContractAddress({ opcode: "CREATE2", from: getAddress(factory), salt: offchainId, bytecode });
}
