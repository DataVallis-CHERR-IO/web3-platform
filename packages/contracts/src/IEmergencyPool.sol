// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IEmergencyPool
/// @notice Minimal interface used by Campaign to report inflows to the EmergencyPool.
interface IEmergencyPool {
    /// @notice Called by a factory-registered Campaign after transferring USDC to the pool.
    /// @param poolId  Sub-pool to credit (unknown → general pool 0).
    /// @param amount  USDC amount already transferred to this contract.
    /// @param donor   Original donor address, or address(0) for sweepUnclaimed (no contributor credit).
    function receiveFromCampaign(uint32 poolId, uint256 amount, address donor) external;
}
