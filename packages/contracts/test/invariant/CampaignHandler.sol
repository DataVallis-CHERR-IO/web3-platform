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
    address public guardian;
    address public beneficiary;

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
    uint256 public exec_claimRefund_rejected;
    uint256 public exec_settleToPool;
    uint256 public exec_settleToPool_rejected;
    uint256 public exec_sweepUnclaimed;
    uint256 public exec_sweepUnclaimed_failed;
    uint256 public exec_sweepUnclaimed_rejected;
    uint256 public exec_releaseT1;
    uint256 public exec_releaseT2;
    uint256 public exec_releaseT3;
    uint256 public exec_releaseSingle;
    uint256 public exec_submitEvidence;
    uint256 public exec_vote;
    uint256 public exec_closeVote_paying; // approved → PAYING
    uint256 public exec_closeVote_completed; // approved → COMPLETED
    uint256 public exec_closeVote_needsReview;
    uint256 public exec_closeVote_rejected;
    uint256 public exec_freeze;
    uint256 public exec_resolve_approve;
    uint256 public exec_resolve_reject;

    constructor(
        Campaign _campaign,
        MockUSDC _usdc,
        PlatformConfig _cfg,
        address _operator,
        address _pool,
        address _guardian,
        address _beneficiary
    ) {
        campaign = _campaign;
        usdc = _usdc;
        config = _cfg;
        operator = _operator;
        pool = _pool;
        guardian = _guardian;
        beneficiary = _beneficiary;

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
        mode = uint8(bound(mode, 0, 0)); // SINGLE only for this handler
        if (campaign.beneficiaryType() == 1) return;

        vm.prank(operator);
        try campaign.setPayoutMode(mode) {} catch {}
    }

    function handler_setPayoutModeMilestones() external {
        if (campaign.state() != Campaign.CampaignState.SUCCEEDED) return;
        if (campaign.payoutModeSet()) return;

        vm.prank(operator);
        try campaign.setPayoutMode(1) {} catch {} // MILESTONES
    }

    function handler_release() external {
        if (campaign.state() != Campaign.CampaignState.SUCCEEDED) return;
        if (!campaign.payoutModeSet()) return;

        if (campaign.payoutMode() == 0) {
            // SINGLE
            uint64 releaseAt = campaign.endTime() + campaign.snapReleaseDelay();
            if (block.timestamp < releaseAt) vm.warp(releaseAt + 1);

            uint256 total = campaign.totalRaised();
            uint256 fee = total * campaign.snapFeeBps() / 10_000;
            try campaign.release() {
                ghost_released = total - fee;
                ghost_feePaid = fee;
                exec_releaseSingle++;
            } catch {}
        } else {
            // MILESTONES T1 only (T2/T3 via closeVote/resolve)
            if (campaign.tranchesReleased() != 0) return;

            uint256 total = campaign.totalRaised();
            uint256 feeBps = campaign.snapFeeBps();
            uint256 net = total - (total * feeBps / 10_000);
            uint256 trancheAmt = net / 3;
            uint256 fee = _trancheFee(0); // a third of the fee per tranche (ADR-061)

            try campaign.release() {
                ghost_released += trancheAmt;
                ghost_feePaid += fee;
                exec_releaseT1++;
            } catch {}
        }
    }

    function handler_submitEvidence() external {
        if (campaign.state() != Campaign.CampaignState.PAYING) return;
        if (campaign.payoutMode() != 1) return;
        if (campaign.tranchesReleased() == 0 || campaign.tranchesReleased() > 2) return;

        vm.prank(beneficiary);
        try campaign.submitEvidence(keccak256("inv-evidence")) {
            exec_submitEvidence++;
        } catch {}
    }

    function handler_vote(uint256 actorSeed, bool approve) external {
        if (campaign.state() != Campaign.CampaignState.VOTING) return;
        if (block.timestamp >= campaign.voteEnd()) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (campaign.donated(actor) == 0) return;
        if (campaign.hasVoted(actor, campaign.currentRound())) return;

        vm.prank(actor);
        try campaign.vote(approve) {
            exec_vote++;
        } catch {}
    }

    /// @dev Fee carried by tranche `t` (0, 1, 2): thirds, the last absorbs the dust (ADR-061).
    function _trancheFee(uint8 t) internal view returns (uint256) {
        uint256 totalFee = campaign.totalRaised() * campaign.snapFeeBps() / 10_000;
        return t < 2 ? totalFee / 3 : totalFee - (totalFee / 3) - (totalFee / 3);
    }

    function handler_closeVote() external {
        if (campaign.state() != Campaign.CampaignState.VOTING) return;
        if (block.timestamp < campaign.voteEnd()) vm.warp(campaign.voteEnd());

        // Pre-calculate tranche amounts in case closeVote releases atomically
        uint8 t = campaign.tranchesReleased();
        uint256 total = campaign.totalRaised();
        uint256 feeBps = campaign.snapFeeBps();
        uint256 net = total - (total * feeBps / 10_000);
        uint256 trancheAmt;
        if (t == 1) {
            trancheAmt = net / 3;
        } else if (t == 2) {
            trancheAmt = net - (net / 3) - (net / 3);
        }
        uint256 trancheFee = _trancheFee(t);

        try campaign.closeVote() {
            Campaign.CampaignState newState = campaign.state();
            if (newState == Campaign.CampaignState.PAYING) {
                // Tranche released atomically (T2)
                ghost_released += trancheAmt;
                ghost_feePaid += trancheFee;
                if (t + 1 == 2) exec_releaseT2++;
                exec_closeVote_paying++;
            } else if (newState == Campaign.CampaignState.COMPLETED) {
                // Tranche released atomically (T3 → COMPLETED)
                ghost_released += trancheAmt;
                ghost_feePaid += trancheFee;
                exec_releaseT3++;
                exec_closeVote_completed++;
            } else if (newState == Campaign.CampaignState.NEEDS_REVIEW) {
                exec_closeVote_needsReview++;
            } else if (newState == Campaign.CampaignState.REJECTED) {
                exec_closeVote_rejected++;
            }
        } catch {}
    }

    function handler_freeze() external {
        Campaign.CampaignState s = campaign.state();
        if (
            s != Campaign.CampaignState.LIVE && s != Campaign.CampaignState.SUCCEEDED
                && s != Campaign.CampaignState.PAYING && s != Campaign.CampaignState.VOTING
                && s != Campaign.CampaignState.NEEDS_REVIEW
        ) return;

        vm.prank(guardian);
        try campaign.freeze() {
            exec_freeze++;
        } catch {}
    }

    function handler_resolve(bool approve) external {
        Campaign.CampaignState s = campaign.state();
        if (s != Campaign.CampaignState.FROZEN && s != Campaign.CampaignState.NEEDS_REVIEW) return;

        // Pre-calculate tranche if resolve(true) from NEEDS_REVIEW releases atomically
        uint256 trancheAmt;
        uint256 trancheFee;
        if (approve && s == Campaign.CampaignState.NEEDS_REVIEW) {
            uint8 t = campaign.tranchesReleased();
            trancheFee = _trancheFee(t);
            uint256 total = campaign.totalRaised();
            uint256 feeBps = campaign.snapFeeBps();
            uint256 net = total - (total * feeBps / 10_000);
            if (t == 1) {
                trancheAmt = net / 3;
            } else if (t == 2) {
                trancheAmt = net - (net / 3) - (net / 3);
            }
        }

        vm.prank(guardian);
        try campaign.resolve(approve) {
            if (approve) {
                if (s == Campaign.CampaignState.NEEDS_REVIEW) {
                    ghost_released += trancheAmt;
                    ghost_feePaid += trancheFee;
                    uint8 newT = campaign.tranchesReleased();
                    if (newT == 2) exec_releaseT2++;
                    else if (newT == 3) exec_releaseT3++;
                }
                exec_resolve_approve++;
            } else {
                exec_resolve_reject++;
            }
        } catch {}
    }

    function handler_claimRefund(uint256 actorSeed) external {
        Campaign.CampaignState s = campaign.state();
        if (s != Campaign.CampaignState.FAILED && s != Campaign.CampaignState.REJECTED) return;
        if (campaign.swept()) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (campaign.donated(actor) == 0) return;
        if (campaign.preference(actor) != 0) return;
        if (campaign.settled(actor)) return;

        uint256 amt;
        if (s == Campaign.CampaignState.FAILED) {
            amt = campaign.donated(actor);
        } else {
            amt = campaign.donated(actor) * campaign.rejectedRemainder() / campaign.totalRaised();
        }

        vm.prank(actor);
        try campaign.claimRefund() {
            ghost_totalRefunded += amt;
            exec_claimRefund++;
            if (s == Campaign.CampaignState.REJECTED) exec_claimRefund_rejected++;
        } catch {}
    }

    function handler_settleToPool(uint256 actorSeed) external {
        Campaign.CampaignState s = campaign.state();
        if (s != Campaign.CampaignState.FAILED && s != Campaign.CampaignState.REJECTED) return;
        if (campaign.swept()) return;
        if (pool == address(0)) return;

        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (campaign.donated(actor) == 0) return;
        if (campaign.preference(actor) != 1) return;
        if (campaign.settled(actor)) return;

        uint256 amt;
        if (s == Campaign.CampaignState.FAILED) {
            amt = campaign.donated(actor);
        } else {
            amt = campaign.donated(actor) * campaign.rejectedRemainder() / campaign.totalRaised();
        }

        try campaign.settleToPool(actor) {
            ghost_totalSentToPool += amt;
            exec_settleToPool++;
            if (s == Campaign.CampaignState.REJECTED) exec_settleToPool_rejected++;
        } catch {}
    }

    function handler_sweepUnclaimed() external {
        Campaign.CampaignState s = campaign.state();
        if (s != Campaign.CampaignState.FAILED && s != Campaign.CampaignState.REJECTED) return;
        if (campaign.swept()) return;
        if (pool == address(0)) return;

        uint64 sweepAt = campaign.settlementStart() + campaign.snapRefundSweepDelay();
        if (block.timestamp < sweepAt) vm.warp(sweepAt + 1);

        uint256 bal = usdc.balanceOf(address(campaign));
        try campaign.sweepUnclaimed() {
            ghost_totalSentToPool += bal;
            exec_sweepUnclaimed++;
            if (s == Campaign.CampaignState.FAILED) exec_sweepUnclaimed_failed++;
            else exec_sweepUnclaimed_rejected++;
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
