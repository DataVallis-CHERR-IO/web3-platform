// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockEmergencyPool} from "../mocks/MockEmergencyPool.sol";
import {CampaignHandler} from "./CampaignHandler.sol";

/// @title CampaignInvariant
/// @notice Handler-based invariant suite.
///
/// Core invariant:
///   usdc.balanceOf(campaign) == totalRaised - released - feePaid - totalRefunded - totalSentToPool
///
/// Additional terminal-state invariants:
///   COMPLETED  → balance == 0
///   FAILED && swept → balance == 0
///   COMPLETED  → released + feePaid == totalRaised (no dust, SINGLE path)
contract CampaignInvariant is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    Campaign campaign;
    MockUSDC usdc;
    CampaignHandler handler;

    address admin = makeAddr("inv-admin");
    address operator = makeAddr("inv-operator");
    address treasury = makeAddr("inv-treasury");
    MockEmergencyPool mockPool;
    address beneficiary = makeAddr("inv-beneficiary");
    address guardian = makeAddr("inv-guardian");

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        factory = new CampaignFactory(cfg, address(new Campaign()));
        mockPool = new MockEmergencyPool();

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(address(mockPool));
        vm.stopPrank();

        vm.prank(operator);
        campaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("inv-campaign"),
                    beneficiary: beneficiary,
                    target: 1_000e6,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0 // ORG — allows SINGLE
                })
            )
        );

        handler = new CampaignHandler(campaign, usdc, cfg, operator, address(mockPool), guardian, beneficiary);

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = CampaignHandler.handler_donate.selector;
        selectors[1] = CampaignHandler.handler_finalize.selector;
        selectors[2] = CampaignHandler.handler_setPayoutMode.selector;
        selectors[3] = CampaignHandler.handler_release.selector;
        selectors[4] = CampaignHandler.handler_claimRefund.selector;
        selectors[5] = CampaignHandler.handler_settleToPool.selector;
        selectors[6] = CampaignHandler.handler_sweepUnclaimed.selector;
        selectors[7] = CampaignHandler.handler_submitEvidence.selector;
        selectors[8] = CampaignHandler.handler_vote.selector;
        selectors[9] = CampaignHandler.handler_closeVote.selector;
        selectors[10] = CampaignHandler.handler_freeze.selector;
        selectors[11] = CampaignHandler.handler_resolve.selector;
        selectors[12] = CampaignHandler.handler_setPayoutModeMilestones.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ── Invariants ────────────────────────────────────────────────────────────

    /// @notice Core balance conservation law.
    function invariant_balanceEquality() public view {
        uint256 balance = usdc.balanceOf(address(campaign));
        uint256 expected = campaign.totalRaised() - campaign.released() - campaign.feePaid() - campaign.totalRefunded()
            - campaign.totalSentToPool();
        assertEq(balance, expected, "balance conservation violated");
    }

    /// @notice totalRaised never exceeds target.
    function invariant_raisedNeverExceedsTarget() public view {
        assertLe(campaign.totalRaised(), campaign.target(), "totalRaised > target");
    }

    /// @notice After COMPLETED, all funds left the contract.
    function invariant_completedBalanceIsZero() public view {
        if (campaign.state() == Campaign.CampaignState.COMPLETED) {
            assertEq(usdc.balanceOf(address(campaign)), 0, "COMPLETED but balance != 0");
        }
    }

    /// @notice After sweep, campaign is empty.
    function invariant_sweptBalanceIsZero() public view {
        if (campaign.state() == Campaign.CampaignState.FAILED && campaign.swept()) {
            assertEq(usdc.balanceOf(address(campaign)), 0, "swept but balance != 0");
        }
    }

    /// @notice SINGLE payout: released + feePaid == totalRaised (no dust anywhere).
    function invariant_singlePayoutExact() public view {
        if (
            campaign.state() == Campaign.CampaignState.COMPLETED && campaign.payoutModeSet()
                && campaign.payoutMode() == 0
        ) {
            assertEq(
                campaign.released() + campaign.feePaid(), campaign.totalRaised(), "SINGLE: released+fee != totalRaised"
            );
        }
    }

    /// @notice MILESTONES payout: released + feePaid == totalRaised when COMPLETED.
    function invariant_milestonesPayoutExact() public view {
        if (
            campaign.state() == Campaign.CampaignState.COMPLETED && campaign.payoutModeSet()
                && campaign.payoutMode() == 1
        ) {
            assertEq(
                campaign.released() + campaign.feePaid(),
                campaign.totalRaised(),
                "MILESTONES: released+fee != totalRaised"
            );
        }
    }

    /// @notice Ghost accounting matches on-chain state.
    function invariant_ghostMatchesOnChain() public view {
        assertEq(handler.ghost_totalRaised(), campaign.totalRaised(), "ghost_totalRaised mismatch");
        assertEq(handler.ghost_released(), campaign.released(), "ghost_released mismatch");
        assertEq(handler.ghost_feePaid(), campaign.feePaid(), "ghost_feePaid mismatch");
        assertEq(handler.ghost_totalRefunded(), campaign.totalRefunded(), "ghost_totalRefunded mismatch");
        assertEq(handler.ghost_totalSentToPool(), campaign.totalSentToPool(), "ghost_totalSentToPool mismatch");
    }

    /// @notice When FAILED && !swept, sum of donated[actor] for unsettled actors == campaign USDC balance.
    function invariant_owedEqualsBalance() public view {
        if (campaign.state() != Campaign.CampaignState.FAILED) return;
        if (campaign.swept()) return;

        uint256 owed;
        uint256 n = handler.actorCount();
        for (uint256 i; i < n; i++) {
            address a = handler.actorAt(i);
            if (!campaign.settled(a)) {
                owed += campaign.donated(a);
            }
        }
        assertEq(owed, usdc.balanceOf(address(campaign)), "owed != balance in FAILED pre-sweep");
    }

    /// @notice Passive counter log — always passes. Counter assertions are in test_allCountersPositive.
    function invariant_logExecCounters() public view {
        assertTrue(true);
    }

    /// @notice Directed test that drives the handler through ALL paths and asserts counters > 0.
    ///         Uses separate campaigns for each flow to guarantee full coverage.
    function test_allCountersPositive() public {
        // ── Flow 1: MILESTONES T1→T2→T3 (approved) ────────────────────────────
        handler.handler_donate(0, 600e6, 0, 0); // actor[0] donates 600 (REFUND)
        handler.handler_donate(1, 400e6, 1, 7); // actor[1] donates 400 (POOL)
        // campaign should be SUCCEEDED (600+400 = 1000 = target)
        handler.handler_setPayoutModeMilestones();
        handler.handler_release(); // T1
        handler.handler_submitEvidence();
        handler.handler_vote(0, true); // actor[0] yes
        handler.handler_vote(1, true); // actor[1] yes
        handler.handler_closeVote(); // → T2 released (PAYING)
        handler.handler_submitEvidence();
        handler.handler_vote(0, true);
        handler.handler_vote(1, true);
        handler.handler_closeVote(); // → T3 released (COMPLETED)

        assertGt(handler.exec_releaseT1(), 0, "exec_releaseT1");
        assertGt(handler.exec_releaseT2(), 0, "exec_releaseT2");
        assertGt(handler.exec_releaseT3(), 0, "exec_releaseT3");
        assertGt(handler.exec_closeVote_paying(), 0, "exec_closeVote_paying");
        assertGt(handler.exec_closeVote_completed(), 0, "exec_closeVote_completed");

        // ── Flow 2: New campaign — MILESTONES → NEEDS_REVIEW → resolve(true) → resolve(false) ──
        CampaignHandler h2;
        {
            vm.prank(operator);
            Campaign c2 = Campaign(
                factory.createCampaign(
                    CampaignFactory.CreateParams({
                        offchainId: keccak256("flow2"),
                        beneficiary: beneficiary,
                        target: 1_000e6,
                        deadline: uint64(block.timestamp + 30 days),
                        beneficiaryType: 0
                    })
                )
            );
            h2 = new CampaignHandler(c2, usdc, cfg, operator, address(mockPool), guardian, beneficiary);
        }
        h2.handler_donate(0, 600e6, 0, 0);
        h2.handler_donate(1, 400e6, 1, 7);
        h2.handler_setPayoutModeMilestones();
        h2.handler_release(); // T1
        h2.handler_submitEvidence();
        // No votes → quorum fails → NEEDS_REVIEW
        h2.handler_closeVote();
        assertGt(h2.exec_closeVote_needsReview(), 0, "exec_closeVote_needsReview");
        // resolve(true) → releases T2 atomically
        h2.handler_resolve(true);
        assertGt(h2.exec_resolve_approve(), 0, "exec_resolve_approve");
        // Now in PAYING again. Submit evidence, vote NO → REJECTED
        h2.handler_submitEvidence();
        h2.handler_vote(0, false); // actor[0] no (600)
        h2.handler_vote(1, false); // actor[1] no (400)
        h2.handler_closeVote();
        assertGt(h2.exec_closeVote_rejected(), 0, "exec_closeVote_rejected");
        // claim refund (actor[0], REFUND pref) and settle to pool (actor[1], POOL pref)
        h2.handler_claimRefund(0);
        assertGt(h2.exec_claimRefund_rejected(), 0, "exec_claimRefund_rejected");
        h2.handler_settleToPool(1);
        assertGt(h2.exec_settleToPool_rejected(), 0, "exec_settleToPool_rejected");
        h2.handler_sweepUnclaimed();
        assertGt(h2.exec_sweepUnclaimed_rejected(), 0, "exec_sweepUnclaimed_rejected");

        // ── Flow 3: SINGLE release ────────────────────────────────────────────
        CampaignHandler h3;
        {
            vm.prank(operator);
            Campaign c3 = Campaign(
                factory.createCampaign(
                    CampaignFactory.CreateParams({
                        offchainId: keccak256("flow3"),
                        beneficiary: beneficiary,
                        target: 1_000e6,
                        deadline: uint64(block.timestamp + 30 days),
                        beneficiaryType: 0
                    })
                )
            );
            h3 = new CampaignHandler(c3, usdc, cfg, operator, address(mockPool), guardian, beneficiary);
        }
        h3.handler_donate(0, 1_000e6, 0, 0);
        h3.handler_setPayoutMode(0); // SINGLE
        h3.handler_release();
        assertGt(h3.exec_releaseSingle(), 0, "exec_releaseSingle");

        // ── Flow 4: FAILED → claimRefund → settleToPool → sweep ──────────────
        CampaignHandler h4;
        {
            vm.prank(operator);
            Campaign c4 = Campaign(
                factory.createCampaign(
                    CampaignFactory.CreateParams({
                        offchainId: keccak256("flow4"),
                        beneficiary: beneficiary,
                        target: 1_000e6,
                        deadline: uint64(block.timestamp + 30 days),
                        beneficiaryType: 0
                    })
                )
            );
            h4 = new CampaignHandler(c4, usdc, cfg, operator, address(mockPool), guardian, beneficiary);
        }
        h4.handler_donate(0, 49e6, 0, 0); // below 10% threshold (49+50=99 < 100)
        h4.handler_donate(1, 50e6, 1, 7); // POOL pref
        h4.handler_finalize(); // → FAILED
        h4.handler_claimRefund(0);
        assertGt(h4.exec_claimRefund(), 0, "exec_claimRefund");
        h4.handler_settleToPool(1);
        assertGt(h4.exec_settleToPool(), 0, "exec_settleToPool");
        h4.handler_sweepUnclaimed();
        assertGt(h4.exec_sweepUnclaimed_failed(), 0, "exec_sweepUnclaimed_failed");

        // ── Flow 5: Freeze → resolve(false) ─────────────────────────────────
        CampaignHandler h5;
        {
            vm.prank(operator);
            Campaign c5 = Campaign(
                factory.createCampaign(
                    CampaignFactory.CreateParams({
                        offchainId: keccak256("flow5"),
                        beneficiary: beneficiary,
                        target: 1_000e6,
                        deadline: uint64(block.timestamp + 30 days),
                        beneficiaryType: 0
                    })
                )
            );
            h5 = new CampaignHandler(c5, usdc, cfg, operator, address(mockPool), guardian, beneficiary);
        }
        h5.handler_donate(0, 1_000e6, 0, 0);
        h5.handler_setPayoutModeMilestones();
        h5.handler_release(); // T1
        h5.handler_freeze();
        assertGt(h5.exec_freeze(), 0, "exec_freeze");
        h5.handler_resolve(false);
        assertGt(h5.exec_resolve_reject(), 0, "exec_resolve_reject");
    }
}
