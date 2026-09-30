// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {EmergencyPool} from "../src/EmergencyPool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Malicious campaign mock that tries to reenter closeAllocation during donateFromPool.
contract MaliciousForReentrancy {
    EmergencyPool public pool;
    uint256 public allocationId;
    IERC20 public usdc;

    constructor(EmergencyPool _pool, uint256 _allocationId, IERC20 _usdc) {
        pool = _pool;
        allocationId = _allocationId;
        usdc = _usdc;
    }

    /// @dev Called by EmergencyPool._deliverAllocation via Campaign.donateFromPool pattern.
    ///      The pool does forceApprove then calls this; we pull tokens then try reentrancy.
    function donateFromPool(uint256 amount) external returns (uint256) {
        usdc.transferFrom(msg.sender, address(this), amount);
        // Attempt reentrant call
        pool.closeAllocation(allocationId);
        return amount;
    }

    // Mimic Campaign interface methods the pool checks
    function state() external pure returns (Campaign.CampaignState) {
        return Campaign.CampaignState.LIVE;
    }

    function deadline() external view returns (uint64) {
        return uint64(block.timestamp + 365 days);
    }

    function remaining() external pure returns (uint256) {
        return type(uint256).max;
    }
}

contract EmergencyPoolTest is Test {
    MockUSDC usdc;
    PlatformConfig cfg;
    Campaign impl;
    CampaignFactory factory;
    EmergencyPool pool;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address beneficiary = makeAddr("beneficiary");
    address donor1 = makeAddr("donor1");
    address donor2 = makeAddr("donor2");
    address donor3 = makeAddr("donor3");
    address alice = makeAddr("alice");

    uint256 constant TARGET = 1000e6;
    uint64 constant DURATION = 60 days;

    // A LIVE campaign created during setUp
    Campaign campaign;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        impl = new Campaign();
        factory = new CampaignFactory(cfg, address(impl));
        pool = new EmergencyPool(cfg, factory);

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(address(pool));
        vm.stopPrank();

        // Create a LIVE campaign via factory
        vm.prank(operator);
        campaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("ep-c1"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0
                })
            )
        );

        // Fund donors
        usdc.mint(donor1, 10_000e6);
        usdc.mint(donor2, 10_000e6);
        usdc.mint(donor3, 10_000e6);
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    function _mintAndApprove(address to, uint256 amount) internal {
        usdc.mint(to, amount);
        vm.prank(to);
        usdc.approve(address(pool), amount);
    }

    /// @dev Create a fresh LIVE campaign with a specific offchainId.
    function _createCampaign(bytes32 offchainId) internal returns (Campaign c) {
        vm.prank(operator);
        c = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: offchainId,
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0
                })
            )
        );
    }

    /// @dev Propose allocation, advance block for checkpoint, return allocation id.
    function _proposeAllocation(uint32 poolId, address camp, uint256 amount) internal returns (uint256 id) {
        vm.prank(operator);
        id = pool.proposeAllocation(poolId, camp, amount, keccak256("reason"));
    }

    // ── Constructor ─────────────────────────────────────────────────────────────

    function test_constructor() public view {
        assertEq(address(pool.config()), address(cfg));
        assertEq(address(pool.factory()), address(factory));
        assertTrue(pool.poolExists(0));
    }

    // ── Sub-pool management ────────────────────────────────────────────────────

    function test_createSubPool() public {
        vm.prank(operator);
        pool.createSubPool(1);
        assertTrue(pool.poolExists(1));
    }

    function test_createSubPool_duplicate_reverts() public {
        vm.prank(operator);
        pool.createSubPool(1);
        vm.prank(operator);
        vm.expectRevert(EmergencyPool.PoolAlreadyExists.selector);
        pool.createSubPool(1);
    }

    function test_createSubPool_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert(EmergencyPool.NotOperator.selector);
        pool.createSubPool(1);
    }

    // ── Donations ──────────────────────────────────────────────────────────────

    function test_donate_generalPool() public {
        _mintAndApprove(donor1, 100e6);
        vm.prank(donor1);
        pool.donate(0, 100e6);

        assertEq(pool.poolBalance(0), 100e6);
        assertEq(usdc.balanceOf(address(pool)), 100e6);

        vm.roll(block.number + 1);
        assertEq(pool.contributedAt(0, donor1, block.number - 1), 100e6);
        assertEq(pool.totalContributedAt(0, block.number - 1), 100e6);
    }

    function test_donate_subPool() public {
        vm.prank(operator);
        pool.createSubPool(5);

        _mintAndApprove(donor1, 50e6);
        vm.prank(donor1);
        pool.donate(5, 50e6);

        assertEq(pool.poolBalance(5), 50e6);
        assertEq(pool.poolBalance(0), 0); // general pool untouched

        vm.roll(block.number + 1);
        assertEq(pool.contributedAt(5, donor1, block.number - 1), 50e6);
    }

    function test_donate_unknownPool_creditsGeneral() public {
        _mintAndApprove(donor1, 100e6);
        vm.prank(donor1);
        pool.donate(999, 100e6); // pool 999 doesn't exist

        assertEq(pool.poolBalance(0), 100e6); // credited to general pool
        assertEq(pool.poolBalance(999), 0);
    }

    function test_donate_belowMinDonation_reverts() public {
        _mintAndApprove(donor1, 1e6);
        vm.prank(donor1);
        vm.expectRevert(EmergencyPool.AmountTooLow.selector);
        pool.donate(0, 0.5e6); // minDonation = 1e6
    }

    function test_receiveFromCampaign_onlyFactory_reverts() public {
        vm.prank(alice);
        vm.expectRevert(EmergencyPool.NotCampaign.selector);
        pool.receiveFromCampaign(0, 100e6, donor1);
    }

    function test_receiveFromCampaign_accounting() public {
        // donor1 donates to campaign with POOL preference, campaign fails, settleToPool calls receiveFromCampaign
        usdc.mint(donor1, 100e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), 100e6);
        vm.prank(donor1);
        campaign.donate(50e6, 1, 0); // pref=1 (EMERGENCY_POOL)

        // Warp past deadline, finalize as FAILED (50 < 100 threshold)
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FAILED));

        uint256 poolBalBefore = pool.poolBalance(0);
        campaign.settleToPool(donor1);

        assertEq(pool.poolBalance(0), poolBalBefore + 50e6);
        assertEq(usdc.balanceOf(address(pool)), 50e6);

        vm.roll(block.number + 1);
        assertEq(pool.contributedAt(0, donor1, block.number - 1), 50e6);
        assertEq(pool.totalContributedAt(0, block.number - 1), 50e6);
    }

    function test_receiveFromCampaign_sweep_noContributed() public {
        // donor1 donates with REFUND pref, campaign fails, sweep sends to pool with donor=address(0)
        usdc.mint(donor1, 100e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), 100e6);
        vm.prank(donor1);
        campaign.donate(50e6, 0, 0); // REFUND preference

        vm.warp(campaign.deadline() + 1);
        campaign.finalize();

        // Warp past sweep delay
        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        campaign.sweepUnclaimed();

        // Pool balance updated but no contributor checkpoints
        assertEq(pool.poolBalance(0), 50e6);

        vm.roll(block.number + 1);
        // address(0) contributed should be 0 (sweep doesn't credit contributed)
        assertEq(pool.contributedAt(0, address(0), block.number - 1), 0);
        // totalContributed should also be 0 since sweep doesn't push checkpoints
        assertEq(pool.totalContributedAt(0, block.number - 1), 0);
    }

    // ── Allocation proposals ───────────────────────────────────────────────────

    function test_proposeAllocation_basic() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 balBefore = pool.poolBalance(0);
        uint256 id = _proposeAllocation(0, address(campaign), 200e6);

        assertEq(pool.poolBalance(0), balBefore - 200e6);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        assertEq(a.poolId, 0);
        assertEq(a.campaign, address(campaign));
        assertEq(a.amount, 200e6);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.VOTING));
        assertEq(a.voteEnd, block.timestamp + cfg.voteWindow());
        assertEq(a.snapQuorumBps, cfg.quorumBps());
        assertEq(a.snapApprovalBps, cfg.approvalBps());
        assertEq(a.proposalBlock, block.number);
    }

    function test_proposeAllocation_notLive_reverts() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);

        // Succeed the campaign so it's no longer LIVE
        usdc.mint(donor1, TARGET);
        vm.prank(donor1);
        usdc.approve(address(campaign), TARGET);
        vm.prank(donor1);
        campaign.donate(TARGET, 0, 0);

        vm.prank(operator);
        vm.expectRevert(EmergencyPool.NotLiveCampaign.selector);
        pool.proposeAllocation(0, address(campaign), 200e6, keccak256("r"));
    }

    function test_proposeAllocation_notFactory_reverts() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);

        vm.prank(operator);
        vm.expectRevert(EmergencyPool.NotFactoryCampaign.selector);
        pool.proposeAllocation(0, alice, 200e6, keccak256("r"));
    }

    function test_proposeAllocation_insufficient_reverts() public {
        _mintAndApprove(donor1, 100e6);
        vm.prank(donor1);
        pool.donate(0, 100e6);

        vm.prank(operator);
        vm.expectRevert(EmergencyPool.InsufficientPoolBalance.selector);
        pool.proposeAllocation(0, address(campaign), 200e6, keccak256("r"));
    }

    function test_proposeAllocation_unauthorized_reverts() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);

        vm.prank(alice);
        vm.expectRevert(EmergencyPool.NotOperator.selector);
        pool.proposeAllocation(0, address(campaign), 200e6, keccak256("r"));
    }

    function test_proposeAllocation_deadlineTooSoon_reverts() public {
        // Create a campaign with a deadline that is valid for factory but too soon for allocation vote
        vm.prank(operator);
        Campaign shortCampaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("short-dl"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 1 days + 1), // just barely valid for factory
                    beneficiaryType: 0
                })
            )
        );

        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);

        // Warp so that block.timestamp + voteWindow (24h) >= deadline
        // deadline = original_ts + 1 day + 1, so warp to original_ts + 1 (voteEnd becomes original_ts + 1 + 86400 = original_ts + 86401 >= deadline)
        vm.warp(block.timestamp + 2);

        vm.prank(operator);
        vm.expectRevert(EmergencyPool.CampaignDeadlineTooSoon.selector);
        pool.proposeAllocation(0, address(shortCampaign), 200e6, keccak256("r"));
    }

    function test_proposeAllocation_samePoolRequired_reverts() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);

        vm.prank(operator);
        pool.createSubPool(2);
        _mintAndApprove(donor2, 500e6);
        vm.prank(donor2);
        pool.donate(2, 500e6);

        // First allocation from pool 0
        _proposeAllocation(0, address(campaign), 100e6);

        // Second allocation from pool 2 to same campaign → PoolIdMismatch
        vm.prank(operator);
        vm.expectRevert(EmergencyPool.PoolIdMismatch.selector);
        pool.proposeAllocation(2, address(campaign), 100e6, keccak256("r"));
    }

    // ── Voting ─────────────────────────────────────────────────────────────────

    function test_voteAllocation_weight() public {
        _mintAndApprove(donor1, 300e6);
        vm.prank(donor1);
        pool.donate(0, 300e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 100e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        assertEq(a.yesVotes, 300e6);
        assertEq(a.noVotes, 0);
        assertTrue(pool.hasVotedAllocation(id, donor1));
    }

    function test_voteAllocation_doubleVote_reverts() public {
        _mintAndApprove(donor1, 300e6);
        vm.prank(donor1);
        pool.donate(0, 300e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 100e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);
        vm.prank(donor1);
        vm.expectRevert(EmergencyPool.AlreadyVoted.selector);
        pool.voteAllocation(id, false);
    }

    function test_voteAllocation_notContributor_reverts() public {
        _mintAndApprove(donor1, 300e6);
        vm.prank(donor1);
        pool.donate(0, 300e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 100e6);

        vm.prank(alice); // never donated
        vm.expectRevert(EmergencyPool.NoVotingWeight.selector);
        pool.voteAllocation(id, true);
    }

    function test_voteAllocation_afterEnd_reverts() public {
        _mintAndApprove(donor1, 300e6);
        vm.prank(donor1);
        pool.donate(0, 300e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 100e6);
        EmergencyPool.Allocation memory a = pool.getAllocation(id);

        vm.warp(a.voteEnd);
        vm.prank(donor1);
        vm.expectRevert(EmergencyPool.VoteEnded.selector);
        pool.voteAllocation(id, true);
    }

    function test_voteAllocation_postProposalContributor_zeroWeight() public {
        _mintAndApprove(donor1, 300e6);
        vm.prank(donor1);
        pool.donate(0, 300e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 100e6);

        // donor2 contributes AFTER the proposal block
        _mintAndApprove(donor2, 200e6);
        vm.prank(donor2);
        pool.donate(0, 200e6);
        vm.roll(block.number + 1);

        // donor2's weight at proposalBlock-1 is 0
        vm.prank(donor2);
        vm.expectRevert(EmergencyPool.NoVotingWeight.selector);
        pool.voteAllocation(id, true);
    }

    // ── Close allocation ───────────────────────────────────────────────────────

    function _setupAndProposeAllocation(uint256 donateAmt, uint256 allocAmt) internal returns (uint256 id) {
        _mintAndApprove(donor1, donateAmt);
        vm.prank(donor1);
        pool.donate(0, donateAmt);
        vm.roll(block.number + 1);
        id = _proposeAllocation(0, address(campaign), allocAmt);
    }

    function test_closeAllocation_quorumApproval_transfers() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);

        uint256 campaignBalBefore = usdc.balanceOf(address(campaign));
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.PASSED));
        assertEq(usdc.balanceOf(address(campaign)), campaignBalBefore + 200e6);
        assertEq(campaign.totalRaised(), 200e6);
    }

    function test_closeAllocation_noQuorum_needsReview() public {
        // donor1 and donor2 both donate; only donor2 votes → quorum not met
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        _mintAndApprove(donor2, 500e6);
        vm.prank(donor2);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);

        // Only donor2 votes (500/1000 = 50%, quorum is 50% → exactly met)
        // To NOT meet quorum, we need less than 50%. Let's use 3 donors: 400+400+200=1000.
        // Actually with 500+500, donor2 alone = 500/1000 = 50%. quorumBps=5000. 500*10000=5000000 >= 1000*5000=5000000 → quorum MET.
        // We need no one to vote. But then totalVoted=0, 0 >= base*quorum → false.
        // So just don't vote at all.

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.NEEDS_REVIEW));
    }

    /// @notice Pool funded only by sweep inflows (no contributor credit): quorumBase==0 → NEEDS_REVIEW.
    function test_closeAllocation_quorumBaseZero_needsReview() public {
        // Create a campaign, fund it below threshold, let it fail, sweep to pool
        vm.prank(operator);
        Campaign failCampaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("sweep-only"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0
                })
            )
        );
        // donor1 donates 50 with REFUND pref (below 10% threshold)
        usdc.mint(donor1, 50e6);
        vm.prank(donor1);
        usdc.approve(address(failCampaign), 50e6);
        vm.prank(donor1);
        failCampaign.donate(50e6, 0, 0); // pref=0 (REFUND)

        vm.warp(failCampaign.deadline() + 1);
        failCampaign.finalize(); // → FAILED

        // sweep (no claims → all goes to pool via sweepUnclaimed with donor=address(0))
        vm.warp(block.timestamp + cfg.refundSweepDelay() + 1);
        failCampaign.sweepUnclaimed();

        // Pool now has 50e6 balance but NO contributor checkpoints (sweep uses address(0))
        assertEq(pool.poolBalance(0), 50e6);
        assertEq(pool.totalContributedAt(0, block.number), 0, "no contributor credit from sweep");

        // Create a new live campaign for the allocation
        vm.prank(operator);
        Campaign liveCampaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("live-for-sweep"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0
                })
            )
        );

        vm.roll(block.number + 1);

        // Propose allocation
        vm.prank(operator);
        uint256 id = pool.proposeAllocation(0, address(liveCampaign), 30e6, keccak256("sweep-alloc"));

        // No one can vote (no contributor weight). Close after window.
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(
            uint8(a.state), uint8(EmergencyPool.AllocationState.NEEDS_REVIEW), "quorumBase==0 must be NEEDS_REVIEW"
        );
    }

    function test_closeAllocation_quorumNoApproval_rejected() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, false); // vote NO

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);

        uint256 poolBalBefore = pool.poolBalance(0);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.REJECTED));
        assertEq(pool.poolBalance(0), poolBalBefore + 200e6);
    }

    function test_closeAllocation_deliveryFailed() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        // Make campaign not LIVE: succeed it before close
        usdc.mint(donor2, TARGET);
        vm.prank(donor2);
        usdc.approve(address(campaign), TARGET);
        vm.prank(donor2);
        campaign.donate(TARGET, 0, 0); // campaign succeeds

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);

        uint256 poolBalBefore = pool.poolBalance(0);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.DELIVERY_FAILED));
        assertEq(pool.poolBalance(0), poolBalBefore + 200e6);
    }

    function test_closeAllocation_beforeEnd_reverts() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        vm.expectRevert(EmergencyPool.VoteNotEnded.selector);
        pool.closeAllocation(id);
    }

    function test_closeAllocation_approvalBoundary() public {
        // Need exactly 51% approval. Two donors: 510 and 490 contributed.
        _mintAndApprove(donor1, 510e6);
        vm.prank(donor1);
        pool.donate(0, 510e6);
        _mintAndApprove(donor2, 490e6);
        vm.prank(donor2);
        pool.donate(0, 490e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true); // 510 yes
        vm.prank(donor2);
        pool.voteAllocation(id, false); // 490 no

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        // 510*10000=5100000 >= 1000*5100=5100000 → true (exactly on boundary)
        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.PASSED));
    }

    function test_closeAllocation_approvalBoundary_oneUnitLess() public {
        // 509 yes, 491 no → 509*10000=5090000 < 1000*5100=5100000 → REJECTED
        _mintAndApprove(donor1, 509e6);
        vm.prank(donor1);
        pool.donate(0, 509e6);
        _mintAndApprove(donor2, 491e6);
        vm.prank(donor2);
        pool.donate(0, 491e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);
        vm.prank(donor2);
        pool.voteAllocation(id, false);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.REJECTED));
    }

    function test_closeAllocation_allowanceZeroAfterPass() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        // After PASSED, allowance pool→campaign should be 0
        assertEq(usdc.allowance(address(pool), address(campaign)), 0);
    }

    function test_closeAllocation_allowanceZeroAfterDeliveryFailed() public {
        uint256 id = _setupAndProposeAllocation(500e6, 200e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        // Make campaign succeed so donateFromPool will revert
        usdc.mint(donor2, TARGET);
        vm.prank(donor2);
        usdc.approve(address(campaign), TARGET);
        vm.prank(donor2);
        campaign.donate(TARGET, 0, 0);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.DELIVERY_FAILED));
        assertEq(usdc.allowance(address(pool), address(campaign)), 0);
    }

    function test_closeAllocation_clipped() public {
        // Campaign has remaining = 1000 - 0 = 1000. Allocate 500. But first donate 800 directly to campaign.
        // So remaining becomes 200. Allocation of 500 should be clipped to 200. Excess 300 back to pool.
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 500e6);

        // Donate 800 directly to campaign to leave only 200 remaining
        usdc.mint(donor2, 800e6);
        vm.prank(donor2);
        usdc.approve(address(campaign), 800e6);
        vm.prank(donor2);
        campaign.donate(800e6, 0, 0);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);

        uint256 poolBalBefore = pool.poolBalance(0);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.PASSED));
        // 200 went to campaign, 300 returned to pool
        assertEq(pool.poolBalance(0), poolBalBefore + 300e6);
        assertEq(campaign.totalRaised(), 1000e6); // 800 + 200 = 1000 (full target)
        assertEq(usdc.allowance(address(pool), address(campaign)), 0);
    }

    // ── Resolve allocation ─────────────────────────────────────────────────────

    function test_resolveAllocation_approve() public {
        // Create NEEDS_REVIEW allocation (no one votes → no quorum)
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);
        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.NEEDS_REVIEW));

        uint256 campaignBalBefore = usdc.balanceOf(address(campaign));
        vm.prank(guardian);
        pool.resolveAllocation(id, true);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.RESOLVED_PASS));
        assertEq(usdc.balanceOf(address(campaign)), campaignBalBefore + 200e6);
    }

    function test_resolveAllocation_reject() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id); // NEEDS_REVIEW

        uint256 poolBalBefore = pool.poolBalance(0);
        vm.prank(guardian);
        pool.resolveAllocation(id, false);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.RESOLVED_REJECT));
        assertEq(pool.poolBalance(0), poolBalBefore + 200e6);
    }

    function test_resolveAllocation_notGuardian_reverts() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id);

        vm.prank(alice);
        vm.expectRevert(EmergencyPool.NotGuardian.selector);
        pool.resolveAllocation(id, true);
    }

    function test_resolveAllocation_wrongState_reverts() public {
        // Allocation in VOTING state → should revert
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);

        vm.prank(guardian);
        vm.expectRevert(EmergencyPool.AllocationNotNeedsReview.selector);
        pool.resolveAllocation(id, true);
    }

    function test_resolveAllocation_deliveryFailed() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(campaign), 200e6);
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id); // NEEDS_REVIEW

        // Make campaign not LIVE: succeed it
        usdc.mint(donor2, TARGET);
        vm.prank(donor2);
        usdc.approve(address(campaign), TARGET);
        vm.prank(donor2);
        campaign.donate(TARGET, 0, 0);

        uint256 poolBalBefore = pool.poolBalance(0);
        vm.prank(guardian);
        pool.resolveAllocation(id, true); // donateFromPool will fail → DELIVERY_FAILED

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.DELIVERY_FAILED));
        assertEq(pool.poolBalance(0), poolBalBefore + 200e6);
    }

    // ── Reclaim ────────────────────────────────────────────────────────────────

    function test_reclaimFromCampaign_failed() public {
        // Pool allocates 50 to a campaign that will FAIL (5% < 10% threshold)
        Campaign failCampaign = _createCampaign(keccak256("fail-reclaim"));

        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(failCampaign), 50e6);

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id); // PASSED, 50 USDC to failCampaign

        // 50/1000 = 5% < 10% threshold → FAILED
        vm.warp(failCampaign.deadline() + 1);
        failCampaign.finalize();
        assertEq(uint8(failCampaign.state()), uint8(Campaign.CampaignState.FAILED));

        uint256 poolBalBefore = pool.poolBalance(0);
        pool.reclaimFromCampaign(address(failCampaign));

        // FAILED → full refund of pool's donated amount
        assertEq(pool.poolBalance(0), poolBalBefore + 50e6);
        assertEq(pool.fundingPool(address(failCampaign)), 0);
    }

    function test_reclaimFromCampaign_rejected() public {
        // Create campaign, fund via pool allocation, succeed, go through milestone rejection
        Campaign rejCampaign = _createCampaign(keccak256("rej-reclaim"));

        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        uint256 id = _proposeAllocation(0, address(rejCampaign), 200e6);
        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);
        pool.closeAllocation(id); // 200 to rejCampaign

        // Also have a real donor bring it to target
        usdc.mint(donor2, 800e6);
        vm.prank(donor2);
        usdc.approve(address(rejCampaign), 800e6);
        vm.prank(donor2);
        rejCampaign.donate(800e6, 0, 0); // now totalRaised = 1000 → SUCCEEDED

        vm.prank(operator);
        rejCampaign.setPayoutMode(1);
        rejCampaign.release(); // T1

        // Guardian rejects
        vm.prank(guardian);
        rejCampaign.freeze();
        vm.prank(guardian);
        rejCampaign.resolve(false); // → REJECTED

        uint256 poolBalBefore = pool.poolBalance(0);
        pool.reclaimFromCampaign(address(rejCampaign));

        // Pool gets pro-rata of rejectedRemainder: 200/1000 * remainder
        uint256 remainder = rejCampaign.rejectedRemainder();
        uint256 expectedRefund = 200e6 * remainder / TARGET;
        assertEq(pool.poolBalance(0), poolBalBefore + expectedRefund);
    }

    // ── Reentrancy ─────────────────────────────────────────────────────────────

    function test_closeAllocation_reentrancy_blocked() public {
        _mintAndApprove(donor1, 500e6);
        vm.prank(donor1);
        pool.donate(0, 500e6);
        vm.roll(block.number + 1);

        // Deploy MaliciousForReentrancy and mock factory.isCampaign to accept it
        MaliciousForReentrancy malicious = new MaliciousForReentrancy(pool, 0, IERC20(address(usdc)));

        vm.mockCall(
            address(factory),
            abi.encodeWithSelector(CampaignFactory.isCampaign.selector, address(malicious)),
            abi.encode(true)
        );

        vm.prank(operator);
        uint256 id = pool.proposeAllocation(0, address(malicious), 200e6, keccak256("r"));
        // id == 0 which matches the allocationId the malicious contract was constructed with

        vm.prank(donor1);
        pool.voteAllocation(id, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        vm.warp(a.voteEnd);

        // closeAllocation → _deliverAllocation → try malicious.donateFromPool()
        //   → malicious pulls tokens, then calls pool.closeAllocation(0) → ReentrancyGuardReentrantCall
        //   → the revert is caught by the try/catch in _deliverAllocation → DELIVERY_FAILED
        // The reentrancy IS blocked (the reentrant call reverts), and the outer call
        // gracefully degrades to DELIVERY_FAILED. Funds return to pool.
        uint256 poolBalBefore = pool.poolBalance(0);
        pool.closeAllocation(id);

        a = pool.getAllocation(id);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.DELIVERY_FAILED));
        assertEq(pool.poolBalance(0), poolBalBefore + 200e6);
    }

    // ── End-to-end ─────────────────────────────────────────────────────────────

    function test_e2e_failedCampaign_poolAllocation_newCampaign_release() public {
        // 1. campaign1 fails, donor1 (POOL pref) settles to pool
        Campaign campaign1 = _createCampaign(keccak256("e2e-c1"));

        usdc.mint(donor1, 100e6);
        vm.prank(donor1);
        usdc.approve(address(campaign1), 100e6);
        vm.prank(donor1);
        campaign1.donate(50e6, 1, 0); // POOL preference, 50 USDC (5% < 10% threshold)

        vm.warp(campaign1.deadline() + 1);
        campaign1.finalize();
        assertEq(uint8(campaign1.state()), uint8(Campaign.CampaignState.FAILED));

        campaign1.settleToPool(donor1);
        assertEq(pool.poolBalance(0), 50e6);

        vm.roll(block.number + 1);

        // 2. Pool proposes allocation to campaign2 (LIVE)
        Campaign campaign2 = _createCampaign(keccak256("e2e-c2"));

        uint256 allocId = _proposeAllocation(0, address(campaign2), 50e6);

        // 3. Vote passes
        vm.prank(donor1);
        pool.voteAllocation(allocId, true);

        EmergencyPool.Allocation memory a = pool.getAllocation(allocId);
        vm.warp(a.voteEnd);

        // 4. Close transfers to campaign2
        pool.closeAllocation(allocId);
        assertEq(uint8(pool.getAllocation(allocId).state), uint8(EmergencyPool.AllocationState.PASSED));
        assertEq(campaign2.totalRaised(), 50e6);

        // 5. Fill campaign2 to target and succeed
        usdc.mint(donor2, TARGET);
        vm.prank(donor2);
        usdc.approve(address(campaign2), TARGET);
        vm.prank(donor2);
        campaign2.donate(TARGET - 50e6, 0, 0); // fills to target
        assertEq(uint8(campaign2.state()), uint8(Campaign.CampaignState.SUCCEEDED));

        // 6. Set payout mode and release
        vm.prank(operator);
        campaign2.setPayoutMode(0); // SINGLE
        vm.warp(campaign2.endTime() + campaign2.snapReleaseDelay() + 1);
        campaign2.release();

        assertEq(uint8(campaign2.state()), uint8(Campaign.CampaignState.COMPLETED));
        uint256 fee = TARGET * cfg.feeBps() / 10_000;
        assertEq(usdc.balanceOf(beneficiary), TARGET - fee);
        assertEq(usdc.balanceOf(treasury), fee);
    }
}
