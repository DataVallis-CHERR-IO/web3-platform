// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {EmergencyPool} from "../../src/EmergencyPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {PoolHandler} from "./PoolHandler.sol";

/// @title PoolInvariant
/// @notice Handler-based invariant suite for EmergencyPool.
///
/// Core invariant:
///   usdc.balanceOf(pool) == pool.poolBalance(0) + handler.ghost_inflightAmount()
///
/// The deterministic test drives ALL handler paths and asserts every counter > 0.
contract PoolInvariant is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    EmergencyPool pool;
    MockUSDC usdc;
    PoolHandler handler;

    address admin = makeAddr("pool-inv-admin");
    address operator = makeAddr("pool-inv-operator");
    address treasury = makeAddr("pool-inv-treasury");
    address guardian = makeAddr("pool-inv-guardian");
    address beneficiary = makeAddr("pool-inv-beneficiary");

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        factory = new CampaignFactory(cfg, address(new Campaign()));

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.setTreasury(treasury);
        vm.stopPrank();

        pool = new EmergencyPool(cfg, factory);

        vm.prank(admin);
        cfg.setEmergencyPool(address(pool));

        handler = new PoolHandler(pool, factory, cfg, usdc, operator, guardian, beneficiary);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = PoolHandler.handler_donate.selector;
        selectors[1] = PoolHandler.handler_propose.selector;
        selectors[2] = PoolHandler.handler_vote.selector;
        selectors[3] = PoolHandler.handler_close.selector;
        selectors[4] = PoolHandler.handler_resolve.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    // ── Invariants ──────────────────────────────────────────────────────────────

    /// @notice Core balance conservation: USDC held == poolBalance + inflight amounts.
    function invariant_balanceConservation() public view {
        uint256 balance = usdc.balanceOf(address(pool));
        uint256 expected = pool.poolBalance(0) + handler.ghost_inflightAmount();
        assertEq(balance, expected, "balance conservation violated");
    }

    /// @notice Pool balance never underflows (implicit via Solidity 0.8, but explicit check).
    function invariant_poolBalanceNonNegative() public view {
        assertTrue(pool.poolBalance(0) <= usdc.balanceOf(address(pool)), "poolBalance > actual USDC");
    }

    /// @notice Passive counter log — always passes.
    function invariant_logExecCounters() public view {
        assertTrue(true);
    }

    // ── Deterministic test ──────────────────────────────────────────────────────

    /// @notice Drives handler through ALL paths and asserts every exec counter > 0.
    function test_allCountersPositive() public {
        // ── Setup: donate so actors have voting weight ──────────────────────────
        handler.handler_donate(0, 5_000e6); // actor[0]
        handler.handler_donate(1, 5_000e6); // actor[1]

        // ── Flow 1: propose → all vote yes → close → PASSED ────────────────────
        handler.handler_propose(1_000e6);
        // Need to vote before voteEnd
        handler.handler_vote(0, 0, true); // actor[0] yes
        handler.handler_vote(0, 1, true); // actor[1] yes
        handler.handler_close(0);
        assertGt(handler.exec_close_passed(), 0, "exec_close_passed");

        // ── Flow 2: propose → all vote no → close → REJECTED ───────────────────
        handler.handler_propose(1_000e6);
        handler.handler_vote(0, 0, false); // actor[0] no
        handler.handler_vote(0, 1, false); // actor[1] no
        handler.handler_close(0);
        assertGt(handler.exec_close_rejected(), 0, "exec_close_rejected");

        // ── Flow 3: propose → no votes → close → NEEDS_REVIEW ──────────────────
        handler.handler_propose(1_000e6);
        handler.handler_close(0); // warp past voteEnd, no votes → quorum fails
        assertGt(handler.exec_close_needsReview(), 0, "exec_close_needsReview");

        // ── Flow 4: NEEDS_REVIEW → resolve approve → RESOLVED_PASS ─────────────
        handler.handler_resolve(0, true);
        assertGt(handler.exec_resolve_pass(), 0, "exec_resolve_pass");

        // ── Flow 5: NEEDS_REVIEW → resolve reject → RESOLVED_REJECT ────────────
        handler.handler_propose(1_000e6);
        handler.handler_close(0);
        handler.handler_resolve(0, false);
        assertGt(handler.exec_resolve_reject(), 0, "exec_resolve_reject");

        // ── Flow 6: DELIVERY_FAILED — campaign no longer LIVE at close time ─────
        // Create a campaign that will succeed before allocation is closed
        vm.prank(operator);
        address campDF = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("df-camp"),
                beneficiary: beneficiary,
                target: 100e6,
                deadline: uint64(block.timestamp + 30 days),
                beneficiaryType: 0
            })
        );
        // We need pool donors with voting weight. Donate more to pool and advance block.
        handler.handler_donate(0, 5_000e6);
        // Propose allocation to this campaign
        vm.prank(operator);
        uint256 dfId = pool.proposeAllocation(0, campDF, 50e6, keccak256("df-reason"));
        // All actors vote YES so quorum + approval met → delivery attempted
        for (uint256 i = 0; i < 5; i++) {
            address voter = handler.actors(i);
            if (pool.contributedAt(0, voter, pool.getAllocation(dfId).proposalBlock - 1) > 0) {
                vm.prank(voter);
                pool.voteAllocation(dfId, true);
            }
        }
        // Fill the campaign so it SUCCEEDs (donateFromPool will revert with NotLive)
        address filler = makeAddr("filler");
        usdc.mint(filler, 100e6);
        vm.startPrank(filler);
        usdc.approve(campDF, 100e6);
        Campaign(campDF).donate(100e6, 0, 0);
        vm.stopPrank();
        // Now campaign is SUCCEEDED. Close the allocation → DELIVERY_FAILED
        EmergencyPool.Allocation memory dfAlloc = pool.getAllocation(dfId);
        vm.warp(dfAlloc.voteEnd);
        pool.closeAllocation(dfId);
        dfAlloc = pool.getAllocation(dfId);
        assertEq(
            uint8(dfAlloc.state),
            uint8(EmergencyPool.AllocationState.DELIVERY_FAILED),
            "exec_close_deliveryFailed: wrong state"
        );

        // ── Flow 7: Clipped delivery — campaign with little remaining space ─────
        vm.prank(operator);
        address campClip = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("clip-camp"),
                beneficiary: beneficiary,
                target: 200e6,
                deadline: uint64(block.timestamp + 30 days),
                beneficiaryType: 0
            })
        );
        // Fill campaign to 190 of 200 target
        address filler2 = makeAddr("filler2");
        usdc.mint(filler2, 190e6);
        vm.startPrank(filler2);
        usdc.approve(campClip, 190e6);
        Campaign(campClip).donate(190e6, 0, 0);
        vm.stopPrank();
        vm.roll(block.number + 1);
        // Propose 50 to a campaign with only 10 remaining → clips to 10
        handler.handler_donate(2, 5_000e6); // refresh voting weight
        vm.prank(operator);
        uint256 clipId = pool.proposeAllocation(0, campClip, 50e6, keccak256("clip-reason"));
        // All actors vote yes
        for (uint256 i; i < 5; i++) {
            address actor = handler.actorAt(i);
            EmergencyPool.Allocation memory clipA = pool.getAllocation(clipId);
            if (pool.contributedAt(0, actor, clipA.proposalBlock - 1) > 0 && !pool.hasVotedAllocation(clipId, actor)) {
                vm.prank(actor);
                pool.voteAllocation(clipId, true);
            }
        }
        {
            EmergencyPool.Allocation memory clipA = pool.getAllocation(clipId);
            vm.warp(clipA.voteEnd);
        }
        uint256 poolBalBefore = pool.poolBalance(0);
        pool.closeAllocation(clipId);
        // Pool should have gotten back unspent: 50 - 10 = 40
        uint256 poolBalAfter = pool.poolBalance(0);
        assertGt(poolBalAfter, poolBalBefore, "clip: poolBalance should increase from returned surplus");

        // ── Flow 8: receiveFromCampaign via settleToPool ────────────────────────
        vm.prank(operator);
        address campSettle = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("settle-camp"),
                beneficiary: beneficiary,
                target: 1_000e6,
                deadline: uint64(block.timestamp + 2 days),
                beneficiaryType: 0
            })
        );
        // Actor donates with pref=1 (POOL), subPoolId=0
        address settler = handler.actorAt(0);
        usdc.mint(settler, 50e6);
        vm.startPrank(settler);
        usdc.approve(campSettle, 50e6);
        Campaign(campSettle).donate(50e6, 1, 0);
        vm.stopPrank();
        // Warp past deadline, finalize → FAILED (50 < 100 = 10% of 1000)
        vm.warp(Campaign(campSettle).deadline() + 1);
        Campaign(campSettle).finalize();
        assertEq(uint8(Campaign(campSettle).state()), uint8(Campaign.CampaignState.FAILED), "settle: not FAILED");
        // settleToPool
        uint256 poolBalBeforeSettle = pool.poolBalance(0);
        Campaign(campSettle).settleToPool(settler);
        assertGt(pool.poolBalance(0), poolBalBeforeSettle, "settle: poolBalance should increase");

        // ── Flow 9: receiveFromCampaign via sweepUnclaimed ──────────────────────
        // Use a separate failed campaign with unclaimed USDC
        vm.prank(operator);
        address campSweep = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("sweep-camp"),
                beneficiary: beneficiary,
                target: 1_000e6,
                deadline: uint64(block.timestamp + 2 days),
                beneficiaryType: 0
            })
        );
        address sweepDonor = handler.actorAt(1);
        usdc.mint(sweepDonor, 30e6);
        vm.startPrank(sweepDonor);
        usdc.approve(campSweep, 30e6);
        Campaign(campSweep).donate(30e6, 0, 0); // pref=REFUND, won't settle
        vm.stopPrank();
        vm.warp(Campaign(campSweep).deadline() + 1);
        Campaign(campSweep).finalize();
        // Warp past refundSweepDelay
        vm.warp(block.timestamp + cfg.refundSweepDelay() + 1);
        uint256 poolBalBeforeSweep = pool.poolBalance(0);
        Campaign(campSweep).sweepUnclaimed();
        assertGt(pool.poolBalance(0), poolBalBeforeSweep, "sweep: poolBalance should increase");

        // ── Flow 10: reclaim from FAILED campaign ───────────────────────────────
        // Target 10_000e6, threshold 10% = 1000e6. Pool donates 200 → below threshold → FAILED.
        vm.prank(operator);
        address campReclaimF = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("reclaim-f-camp"),
                beneficiary: beneficiary,
                target: 10_000e6,
                deadline: uint64(block.timestamp + 30 days),
                beneficiaryType: 0
            })
        );
        // Pool allocates to this campaign
        handler.handler_donate(3, 5_000e6); // ensure pool has funds
        vm.prank(operator);
        uint256 reclaimFId = pool.proposeAllocation(0, campReclaimF, 200e6, keccak256("reclaim-f"));
        // All vote yes
        {
            EmergencyPool.Allocation memory ra = pool.getAllocation(reclaimFId);
            for (uint256 i; i < 5; i++) {
                address actor = handler.actorAt(i);
                if (
                    pool.contributedAt(0, actor, ra.proposalBlock - 1) > 0
                        && !pool.hasVotedAllocation(reclaimFId, actor)
                ) {
                    vm.prank(actor);
                    pool.voteAllocation(reclaimFId, true);
                }
            }
            vm.warp(ra.voteEnd);
        }
        pool.closeAllocation(reclaimFId);
        // Campaign has 200 from pool. Warp past deadline → FAILED
        vm.warp(Campaign(campReclaimF).deadline() + 1);
        Campaign(campReclaimF).finalize();
        assertEq(uint8(Campaign(campReclaimF).state()), uint8(Campaign.CampaignState.FAILED), "reclaim-f: not FAILED");
        uint256 poolBalBeforeReclaim = pool.poolBalance(0);
        pool.reclaimFromCampaign(campReclaimF);
        assertGt(pool.poolBalance(0), poolBalBeforeReclaim, "reclaim-f: poolBalance should increase");

        // ── Flow 11: reclaim from REJECTED campaign ─────────────────────────────
        vm.prank(operator);
        address campReclaimR = factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256("reclaim-r-camp"),
                beneficiary: beneficiary,
                target: 1_000e6,
                deadline: uint64(block.timestamp + 30 days),
                beneficiaryType: 0
            })
        );
        // Pool allocates 200 to campaign
        handler.handler_donate(4, 5_000e6);
        vm.prank(operator);
        uint256 reclaimRId = pool.proposeAllocation(0, campReclaimR, 200e6, keccak256("reclaim-r"));
        {
            EmergencyPool.Allocation memory ra = pool.getAllocation(reclaimRId);
            for (uint256 i; i < 5; i++) {
                address actor = handler.actorAt(i);
                if (
                    pool.contributedAt(0, actor, ra.proposalBlock - 1) > 0
                        && !pool.hasVotedAllocation(reclaimRId, actor)
                ) {
                    vm.prank(actor);
                    pool.voteAllocation(reclaimRId, true);
                }
            }
            vm.warp(ra.voteEnd);
        }
        pool.closeAllocation(reclaimRId);
        // Pool donated 200. Now external donor fills to 1000 → SUCCEEDED
        address rFiller = makeAddr("r-filler");
        usdc.mint(rFiller, 800e6);
        vm.startPrank(rFiller);
        usdc.approve(campReclaimR, 800e6);
        Campaign(campReclaimR).donate(800e6, 0, 0);
        vm.stopPrank();
        assertEq(
            uint8(Campaign(campReclaimR).state()), uint8(Campaign.CampaignState.SUCCEEDED), "reclaim-r: not SUCCEEDED"
        );
        // Set milestones, release T1, submit evidence, vote NO → REJECTED
        vm.prank(operator);
        Campaign(campReclaimR).setPayoutMode(1);
        Campaign(campReclaimR).release();
        vm.prank(beneficiary);
        Campaign(campReclaimR).submitEvidence(keccak256("evidence"));
        // rFiller votes no (has 800 weight, pool has 200 but pref=REFUND so no quorum exclusion)
        vm.prank(rFiller);
        Campaign(campReclaimR).vote(false);
        vm.warp(Campaign(campReclaimR).voteEnd());
        Campaign(campReclaimR).closeVote();
        assertEq(
            uint8(Campaign(campReclaimR).state()), uint8(Campaign.CampaignState.REJECTED), "reclaim-r: not REJECTED"
        );
        uint256 poolBalBeforeReclaimR = pool.poolBalance(0);
        pool.reclaimFromCampaign(campReclaimR);
        assertGt(pool.poolBalance(0), poolBalBeforeReclaimR, "reclaim-r: poolBalance should increase");

        // ── Assert all exec counters ────────────────────────────────────────────
        assertGt(handler.exec_donate(), 0, "exec_donate");
        assertGt(handler.exec_propose(), 0, "exec_propose");
        assertGt(handler.exec_vote(), 0, "exec_vote");
        assertGt(handler.exec_close_passed(), 0, "exec_close_passed final");
        assertGt(handler.exec_close_rejected(), 0, "exec_close_rejected final");
        assertGt(handler.exec_close_needsReview(), 0, "exec_close_needsReview final");
        assertGt(handler.exec_resolve_pass(), 0, "exec_resolve_pass final");
        assertGt(handler.exec_resolve_reject(), 0, "exec_resolve_reject final");
    }
}
