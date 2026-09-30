// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {Campaign} from "../../src/Campaign.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Handler for the campaign invariant suite.
///         Ghost variables track every USDC outflow for cross-checking.
contract CampaignHandler is CommonBase, StdCheats, StdUtils {
    Campaign public campaign;
    MockUSDC public usdc;
    PlatformConfig public config;
    address public operator;
    address public pool;

    // Fixed actor set
    address[] public actors;

    // Ghost accounting (mirrors on-chain state for invariant verification)
    uint256 public ghost_totalRaised;
    uint256 public ghost_released;
    uint256 public ghost_feePaid;
    uint256 public ghost_totalRefunded;
    uint256 public ghost_totalSentToPool;

    // Execution counters (prove handlers actually ran, not just reverted)
    uint256 public exec_claimRefund;
    uint256 public exec_settleToPool;
    uint256 public exec_sweepUnclaimed;

    constructor(Campaign _campaign, MockUSDC _usdc, PlatformConfig _cfg, address _operator, address _pool) {
        campaign = _campaign;
        usdc = _usdc;
        config = _cfg;
        operator = _operator;
        pool = _pool;

        for (uint256 i; i < 5; i++) {
            actors.push(address(uint160(0xA000 + i)));
        }
    }

    // ── Handlers ──────────────────────────────────────────────────────────────

    function handler_donate(uint256 actorSeed, uint256 amount, uint8 pref, uint32 subPoolId) external {
        if (campaign.state() != Campaign.CampaignState.LIVE) return;
        if (block.timestamp >= campaign.deadline()) return;
        uint256 rem = campaign.remaining();
        if (rem == 0) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        pref = uint8(bound(pref, 0, 1));
        amount = bound(amount, config.minDonation(), rem < config.minDonation() ? config.minDonation() : rem);
        uint256 clipped = amount > rem ? rem : amount;

        usdc.mint(actor, clipped);
        vm.startPrank(actor);
        usdc.approve(address(campaign), clipped);
        try campaign.donate(clipped, pref, subPoolId) {
            ghost_totalRaised += clipped;
        } catch {}
        vm.stopPrank();
    }

    function handler_finalize() external {
        if (campaign.state() != Campaign.CampaignState.LIVE) return;
        vm.warp(campaign.deadline() + 1);
        try campaign.finalize() {} catch {}
    }

    function handler_setPayoutMode(uint8 mode) external {
        if (campaign.state() != Campaign.CampaignState.SUCCEEDED) return;
        if (campaign.payoutModeSet()) return;
        mode = uint8(bound(mode, 0, 0)); // only SINGLE in TASK-002
        if (campaign.beneficiaryType() == 1) return;

        vm.prank(operator);
        try campaign.setPayoutMode(mode) {} catch {}
    }

    function handler_release() external {
        if (campaign.state() != Campaign.CampaignState.SUCCEEDED) return;
        if (!campaign.payoutModeSet() || campaign.payoutMode() != 0) return;

        uint256 total = campaign.totalRaised();
        uint256 fee = total * campaign.snapFeeBps() / 10_000;
        try campaign.release() {
            ghost_released = total - fee;
            ghost_feePaid = fee;
        } catch {}
    }

    function handler_claimRefund(uint256 actorSeed) external {
        if (campaign.state() != Campaign.CampaignState.FAILED) return;
        if (campaign.swept()) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (campaign.donated(actor) == 0) return;
        if (campaign.preference(actor) != 0) return;
        if (campaign.settled(actor)) return;

        uint256 amt = campaign.donated(actor);
        vm.prank(actor);
        try campaign.claimRefund() {
            ghost_totalRefunded += amt;
            exec_claimRefund++;
        } catch {}
    }

    function handler_settleToPool(uint256 actorSeed) external {
        if (campaign.state() != Campaign.CampaignState.FAILED) return;
        if (campaign.swept()) return;
        if (pool == address(0)) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (campaign.donated(actor) == 0) return;
        if (campaign.preference(actor) != 1) return;
        if (campaign.settled(actor)) return;

        uint256 amt = campaign.donated(actor);
        try campaign.settleToPool(actor) {
            ghost_totalSentToPool += amt;
            exec_settleToPool++;
        } catch {}
    }

    function handler_sweepUnclaimed() external {
        if (campaign.state() != Campaign.CampaignState.FAILED) return;
        if (campaign.swept()) return;
        if (pool == address(0)) return;

        uint64 sweepAt = campaign.endTime() + campaign.snapRefundSweepDelay();
        if (block.timestamp < sweepAt) vm.warp(sweepAt + 1);

        uint256 bal = usdc.balanceOf(address(campaign));
        try campaign.sweepUnclaimed() {
            ghost_totalSentToPool += bal;
            exec_sweepUnclaimed++;
        } catch {}
    }

    // ── Actor tracking for owed-equals-balance invariant ────────────────────

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}
