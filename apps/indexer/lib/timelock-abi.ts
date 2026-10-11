import { parseAbi } from "viem";

// The subset of OpenZeppelin v5 `governance/TimelockController.sol`
// (packages/contracts/lib/openzeppelin-contracts) the indexer needs: the events of
// every scheduled, executed and cancelled call, and the view reconcile compares
// with (TASK-023d, review M-02). The timelock holds DEFAULT_ADMIN_ROLE of
// PlatformConfig, so every change to fees, the Emergency Pool address, the
// treasury or the roles passes through these events first.
export const TimelockControllerAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event CallSalt(bytes32 indexed id, bytes32 salt)",
  "event Cancelled(bytes32 indexed id)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
]);

/** TimelockController._DONE_TIMESTAMP: getTimestamp() of an executed operation. */
export const DONE_TIMESTAMP = 1n;
