// Function selectors the timelock watcher classifies by (TASK-023d, review M-02).
// Shared by the web app (public page, Emergency Pool notice) and the worker (admin
// email), which has no viem. First 4 bytes of keccak256 of the signature; checked
// against the PlatformConfig ABI in test/timelock-selectors.test.ts.

/** Calls that change where money goes. */
export const MONEY_SELECTORS = ["0x1d7ad9d8" /* setEmergencyPool(address) */, "0xf0f44260" /* setTreasury(address) */] as const;

/** Calls that change who can act: roles and the timelock delay. */
export const ROLE_SELECTORS = [
  "0x2f2ff15d" /* grantRole(bytes32,address) */,
  "0xd547741f" /* revokeRole(bytes32,address) */,
  "0x36568abe" /* renounceRole(bytes32,address) */,
  "0x64d62353" /* updateDelay(uint256) */,
] as const;

/** The other PlatformConfig setters. A call with any selector not listed in these three lists is "unknown". */
export const SETTING_SELECTORS = [
  "0x023b1fc9" /* setFeeBps(uint16) */,
  "0xaaad8151" /* setSuccessThresholdBps(uint16) */,
  "0x9e33a38e" /* setVoteWindow(uint32) */,
  "0x0527aab6" /* setQuorumBps(uint16) */,
  "0xe692424f" /* setApprovalBps(uint16) */,
  "0x2d75c9a9" /* setRefundSweepDelay(uint32) */,
  "0x83a6595f" /* setMinDonation(uint256) */,
  "0x687e6172" /* setReleaseDelay(uint32) */,
] as const;
