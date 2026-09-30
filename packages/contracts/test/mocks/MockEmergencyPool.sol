// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IEmergencyPool} from "../../src/IEmergencyPool.sol";

/// @notice Minimal mock used by Campaign tests that need a valid receiveFromCampaign target.
contract MockEmergencyPool is IEmergencyPool {
    uint256 public lastPoolId;
    uint256 public lastAmount;
    address public lastDonor;

    function receiveFromCampaign(uint32 poolId, uint256 amount, address donor) external override {
        lastPoolId = poolId;
        lastAmount = amount;
        lastDonor = donor;
    }
}
