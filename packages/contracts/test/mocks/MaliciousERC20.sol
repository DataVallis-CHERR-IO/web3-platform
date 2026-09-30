// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockUSDC} from "./MockUSDC.sol";
import {Campaign} from "../../src/Campaign.sol";

/// @dev ERC20 that re-enters a Campaign function on transfer. Used to prove that
///      ReentrancyGuard blocks re-entry even on EIP-1167 clones (no constructor).
contract MaliciousERC20 is MockUSDC {
    Campaign public reentryTarget;
    bool private _attacking;
    uint8 public attackMode; // 0 = claimRefund, 1 = release

    function setReentryTarget(Campaign _target) external {
        reentryTarget = _target;
    }

    function setAttackMode(uint8 _mode) external {
        attackMode = _mode;
    }

    /// @dev On the first transfer out of the campaign, attempt to re-enter.
    function transfer(address to, uint256 amount) public override returns (bool) {
        if (address(reentryTarget) != address(0) && !_attacking) {
            _attacking = true;
            if (attackMode == 0) {
                reentryTarget.claimRefund();
            } else {
                reentryTarget.release();
            }
            _attacking = false;
        }
        return super.transfer(to, amount);
    }
}
