// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdError} from "forge-std/StdError.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {EmergencyPool} from "../../src/EmergencyPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @title ReviewFindings
/// @notice TASK-023a security review: each test pins down the current behaviour behind
///         one finding of `docs/audit/SMART-CONTRACT-SECURITY-REVIEW.md`, so the report
///         is backed by executable evidence. If a finding is fixed, its test must be
///         updated together with the report (the test fails on purpose).
contract ReviewFindingsTest is Test {
    MockUSDC usdc;
    PlatformConfig cfg;
    CampaignFactory factory;
    EmergencyPool pool;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address beneficiary = makeAddr("beneficiary");
    address giver = makeAddr("giver");
    address donor = makeAddr("donor");

    uint256 constant TARGET = 1000e6;
    uint32 constant SUBPOOL = 2;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        factory = new CampaignFactory(cfg, address(new Campaign()));
        pool = new EmergencyPool(cfg, factory);
        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(address(pool));
        vm.stopPrank();
        vm.prank(operator);
        pool.createSubPool(SUBPOOL);
        usdc.mint(giver, 10_000e6);
        usdc.mint(donor, 10_000e6);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _campaign(bytes32 id, uint64 duration) internal returns (Campaign c) {
        vm.prank(operator);
        c = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: id,
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp) + duration,
                    beneficiaryType: 0
                })
            )
        );
    }

    function _giveToSubpool(uint256 amount) internal {
        vm.startPrank(giver);
        usdc.approve(address(pool), amount);
        pool.donate(SUBPOOL, amount);
        vm.stopPrank();
        vm.roll(block.number + 1); // weight counts from the block before a proposal
    }

    /// @dev Proposes `amount` from SUBPOOL to `c`, the giver votes `approve`, the window ends.
    function _proposeAndVote(Campaign c, uint256 amount, bool approve) internal returns (uint256 id) {
        vm.prank(operator);
        id = pool.proposeAllocation(SUBPOOL, address(c), amount, keccak256("reason"));
        vm.prank(giver);
        pool.voteAllocation(id, approve);
        vm.warp(block.timestamp + cfg.voteWindow());
    }

    // ── L-01 ─────────────────────────────────────────────────────────────────
    /// Sub-pool money in a failed campaign returns to the GENERAL pool (0) when the
    /// campaign is swept before anyone calls reclaimFromCampaign.
    function test_L01_sweepSendsSubpoolMoneyToGeneralPool() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l01"), 30 days);
        uint256 id = _proposeAndVote(c, 50e6, true);
        pool.closeAllocation(id);
        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.PASSED));
        assertEq(pool.poolBalance(SUBPOOL), 450e6);

        // 50 of 1,000 USDC is under the 10 % success threshold: the campaign fails.
        vm.warp(c.deadline());
        c.finalize();
        assertEq(uint8(c.state()), uint8(Campaign.CampaignState.FAILED));

        // Nobody reclaims; after the refund window anyone sweeps.
        vm.warp(uint256(c.settlementStart()) + c.snapRefundSweepDelay());
        c.sweepUnclaimed();

        assertEq(pool.poolBalance(SUBPOOL), 450e6, "the sub-pool does not get its 50 USDC back");
        assertEq(pool.poolBalance(0), 50e6, "the general pool receives it instead");
        vm.expectRevert(Campaign.AlreadySwept.selector);
        pool.reclaimFromCampaign(address(c));
    }

    /// The intended path: reclaim before the sweep credits the funding sub-pool.
    function test_L01_reclaimBeforeSweepCreditsTheSubpool() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l01b"), 30 days);
        pool.closeAllocation(_proposeAndVote(c, 50e6, true));
        vm.warp(c.deadline());
        c.finalize();
        pool.reclaimFromCampaign(address(c));
        assertEq(pool.poolBalance(SUBPOOL), 500e6);
        assertEq(pool.poolBalance(0), 0);
    }

    // ── L-02 ─────────────────────────────────────────────────────────────────
    /// A campaign stays bound to the sub-pool of its first proposal, even when that
    /// proposal was rejected and no money moved.
    function test_L02_fundingPoolBindingSurvivesRejectedProposal() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l02"), 60 days);
        uint256 id = _proposeAndVote(c, 50e6, false);
        pool.closeAllocation(id);
        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.REJECTED));
        assertTrue(pool.hasFundingPool(address(c)));

        // The general pool has money too, but cannot fund this campaign any more.
        vm.startPrank(donor);
        usdc.approve(address(pool), 100e6);
        pool.donate(0, 100e6);
        vm.stopPrank();
        vm.prank(operator);
        vm.expectRevert(EmergencyPool.PoolIdMismatch.selector);
        pool.proposeAllocation(0, address(c), 10e6, keccak256("other"));
    }

    // ── L-06 ─────────────────────────────────────────────────────────────────
    /// Freezing a LIVE campaign does not extend its deadline (a VOTING campaign gets
    /// the frozen time back; a LIVE one loses it).
    function test_L06_freezeDoesNotExtendLiveDeadline() public {
        Campaign c = _campaign(keccak256("l06"), 10 days);
        uint64 deadline = c.deadline();
        vm.prank(guardian);
        c.freeze();
        vm.warp(uint256(deadline) + 1);
        vm.prank(guardian);
        c.resolve(true);
        assertEq(uint8(c.state()), uint8(Campaign.CampaignState.LIVE));
        assertEq(c.deadline(), deadline);
        vm.startPrank(donor);
        usdc.approve(address(c), 10e6);
        vm.expectRevert(Campaign.PastDeadline.selector);
        c.donate(10e6, 0, 0);
        vm.stopPrank();
    }

    // ── I-01 ─────────────────────────────────────────────────────────────────
    /// An allocation id that was never proposed reads as VOTING (enum value 0), and
    /// closing it reverts with an arithmetic panic instead of a named error.
    function test_I01_unknownAllocationReadsAsVotingAndPanicsOnClose() public {
        EmergencyPool.Allocation memory a = pool.getAllocation(42);
        assertEq(uint8(a.state), uint8(EmergencyPool.AllocationState.VOTING));
        assertEq(a.campaign, address(0));
        vm.expectRevert(stdError.arithmeticError);
        pool.closeAllocation(42);
        vm.expectRevert(EmergencyPool.VoteEnded.selector);
        pool.voteAllocation(42, true);
    }

    // ── I-10 (analysed, not a finding) ───────────────────────────────────────
    /// Gas griefing of the try/catch in _deliverAllocation: with any gas limit, a
    /// closeAllocation that succeeds must deliver (PASSED) to a campaign that accepts
    /// the money — never DELIVERY_FAILED because the inner call ran out of gas.
    function test_I10_limitedGasCannotForceDeliveryFailed() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("i10"), 30 days);
        uint256 id = _proposeAndVote(c, 50e6, true);
        uint256 succeeded;
        for (uint256 gasLimit = 30_000; gasLimit <= 400_000; gasLimit += 2_500) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(pool).call{gas: gasLimit}(abi.encodeCall(EmergencyPool.closeAllocation, (id)));
            if (ok) {
                succeeded++;
                assertEq(
                    uint8(pool.getAllocation(id).state),
                    uint8(EmergencyPool.AllocationState.PASSED),
                    "a gas-limited close must not end in DELIVERY_FAILED"
                );
            }
            vm.revertToState(snap);
        }
        assertGt(succeeded, 0, "the loop must reach a gas limit that is enough");
    }
}
