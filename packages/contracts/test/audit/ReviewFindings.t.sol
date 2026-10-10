// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {EmergencyPool} from "../../src/EmergencyPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @title ReviewFindings
/// @notice Security review (TASK-023a/c, `docs/audit/SMART-CONTRACT-SECURITY-REVIEW.md`):
///         one test per finding that can be shown in code. Report v1.0 pinned the
///         behaviour as found; v1.1 (TASK-023c, ADR-061) pins the fixed behaviour.
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

    // ── L-01 (fixed, ADR-061) ────────────────────────────────────────────────
    /// Sub-pool money in a failed campaign goes back to its FUNDING sub-pool even when the
    /// campaign is swept before anyone calls reclaimFromCampaign.
    function test_L01_sweepReturnsPoolMoneyToFundingSubpool() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l01"), 30 days);
        uint256 id = _proposeAndVote(c, 50e6, true);
        pool.closeAllocation(id);
        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.PASSED));
        assertEq(pool.poolBalance(SUBPOOL), 450e6);

        // A donor gives 20 USDC with the "send to the pool" choice for sub-pool 3 (unknown → 0).
        vm.startPrank(donor);
        usdc.approve(address(c), 20e6);
        c.donate(20e6, 1, 3);
        vm.stopPrank();

        // 70 of 1,000 USDC is under the 10 % success threshold: the campaign fails.
        vm.warp(c.deadline());
        c.finalize();
        assertEq(uint8(c.state()), uint8(Campaign.CampaignState.FAILED));

        // Nobody reclaims or settles; after the refund window anyone sweeps.
        vm.warp(uint256(c.settlementStart()) + c.snapRefundSweepDelay());
        c.sweepUnclaimed();

        assertEq(pool.poolBalance(SUBPOOL), 500e6, "the funding sub-pool gets its 50 USDC back");
        assertEq(pool.poolBalance(0), 20e6, "only the donor's unsettled money is a plain sweep");
        assertEq(pool.totalContributedAt(SUBPOOL, block.number), 500e6, "returning pool money gives no new weight");
        assertEq(usdc.balanceOf(address(c)), 0);
        assertTrue(c.settled(address(pool)));
        vm.expectRevert(Campaign.AlreadySwept.selector);
        pool.reclaimFromCampaign(address(c));
    }

    /// Same for a REJECTED campaign: the pool's pro-rata share returns to its sub-pool.
    function test_L01_sweepOfRejectedCampaignReturnsProRataShare() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l01r"), 30 days);
        pool.closeAllocation(_proposeAndVote(c, 100e6, true));
        vm.startPrank(donor);
        usdc.approve(address(c), 900e6);
        c.donate(900e6, 0, 0); // reaches the target: SUCCEEDED
        vm.stopPrank();
        vm.prank(guardian);
        c.freeze();
        vm.prank(guardian);
        c.resolve(false); // REJECTED before any payout: remainder = everything
        vm.warp(uint256(c.settlementStart()) + c.snapRefundSweepDelay());
        c.sweepUnclaimed();
        assertEq(pool.poolBalance(SUBPOOL), 500e6, "100 USDC back to the funding sub-pool");
        assertEq(pool.poolBalance(0), 900e6, "the donor's unclaimed refund is a plain sweep");
    }

    /// The reclaim path still works and the sweep afterwards does not count the pool twice.
    function test_L01_reclaimThenSweepDoesNotDoubleCount() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l01b"), 30 days);
        pool.closeAllocation(_proposeAndVote(c, 50e6, true));
        vm.warp(c.deadline());
        c.finalize();
        pool.reclaimFromCampaign(address(c));
        assertEq(pool.poolBalance(SUBPOOL), 500e6);
        vm.warp(uint256(c.settlementStart()) + c.snapRefundSweepDelay());
        c.sweepUnclaimed();
        assertEq(pool.poolBalance(SUBPOOL), 500e6);
        assertEq(pool.poolBalance(0), 0);
    }

    // ── L-02 (fixed, ADR-061) ────────────────────────────────────────────────
    /// A rejected proposal no longer binds the campaign: another sub-pool may fund it.
    function test_L02_rejectedProposalDoesNotBindCampaign() public {
        _giveToSubpool(500e6);
        Campaign c = _campaign(keccak256("l02"), 60 days);
        uint256 id = _proposeAndVote(c, 50e6, false);
        pool.closeAllocation(id);
        assertEq(uint8(pool.getAllocation(id).state), uint8(EmergencyPool.AllocationState.REJECTED));
        assertFalse(pool.hasFundingPool(address(c)));
        assertEq(pool.openAllocations(address(c)), 0);

        vm.startPrank(donor);
        usdc.approve(address(pool), 100e6);
        pool.donate(0, 100e6);
        vm.stopPrank();
        vm.prank(operator);
        pool.proposeAllocation(0, address(c), 10e6, keccak256("other"));
        assertEq(pool.openAllocations(address(c)), 1);
        assertEq(pool.reservedPool(address(c)), 0);
    }

    /// While a proposal is open, another sub-pool cannot propose to the same campaign;
    /// after delivery the campaign is bound to the sub-pool that paid.
    function test_L02_openProposalReservesAndDeliveryBinds() public {
        _giveToSubpool(500e6);
        vm.startPrank(donor);
        usdc.approve(address(pool), 100e6);
        pool.donate(0, 100e6);
        vm.stopPrank();
        Campaign c = _campaign(keccak256("l02b"), 60 days);
        vm.prank(operator);
        uint256 id = pool.proposeAllocation(SUBPOOL, address(c), 50e6, keccak256("r"));
        vm.prank(operator);
        vm.expectRevert(EmergencyPool.PoolIdMismatch.selector);
        pool.proposeAllocation(0, address(c), 10e6, keccak256("r2"));
        vm.prank(giver);
        pool.voteAllocation(id, true);
        vm.warp(block.timestamp + cfg.voteWindow());
        pool.closeAllocation(id);
        assertTrue(pool.hasFundingPool(address(c)));
        assertEq(pool.fundingPool(address(c)), SUBPOOL);
        vm.prank(operator);
        vm.expectRevert(EmergencyPool.PoolIdMismatch.selector);
        pool.proposeAllocation(0, address(c), 10e6, keccak256("r3"));
    }

    // ── L-06 (fixed, ADR-061) ────────────────────────────────────────────────
    /// Unfreezing a LIVE campaign gives the frozen time back to its deadline.
    function test_L06_unfreezeExtendsLiveDeadline() public {
        Campaign c = _campaign(keccak256("l06"), 10 days);
        uint64 deadline = c.deadline();
        vm.warp(block.timestamp + 2 days);
        vm.prank(guardian);
        c.freeze();
        vm.warp(uint256(deadline) + 1); // frozen for 8 days + 1 s
        vm.prank(guardian);
        c.resolve(true);
        assertEq(uint8(c.state()), uint8(Campaign.CampaignState.LIVE));
        assertEq(c.deadline(), deadline + 8 days + 1, "deadline extended by the frozen time");
        vm.startPrank(donor);
        usdc.approve(address(c), 10e6);
        c.donate(10e6, 0, 0);
        vm.stopPrank();
        assertEq(c.totalRaised(), 10e6);
        vm.expectRevert(Campaign.DeadlineNotReached.selector);
        c.finalize();
    }

    // ── I-01 (fixed, ADR-061) ────────────────────────────────────────────────
    /// Unknown allocation ids revert with a named error everywhere.
    function test_I01_unknownAllocationHasNamedError() public {
        vm.expectRevert(EmergencyPool.AllocationDoesNotExist.selector);
        pool.getAllocation(42);
        vm.expectRevert(EmergencyPool.AllocationDoesNotExist.selector);
        pool.closeAllocation(42);
        vm.expectRevert(EmergencyPool.AllocationDoesNotExist.selector);
        pool.voteAllocation(42, true);
        vm.prank(guardian);
        vm.expectRevert(EmergencyPool.AllocationDoesNotExist.selector);
        pool.resolveAllocation(42, true);
    }

    // ── I-07 (fixed, ADR-061) ────────────────────────────────────────────────
    function test_I07_minDonationHasUpperBound() public {
        vm.startPrank(admin);
        cfg.setMinDonation(1000e6);
        assertEq(cfg.minDonation(), 1000e6);
        vm.expectRevert(PlatformConfig.MinDonationTooHigh.selector);
        cfg.setMinDonation(1000e6 + 1);
        vm.stopPrank();
    }

    // ── L-03 (fixed, ADR-061) ────────────────────────────────────────────────
    /// A rejection after the first milestone refunds the fee of the unpaid tranches.
    function test_L03_rejectionRefundsUnpaidFee() public {
        Campaign c = _campaign(keccak256("l03"), 30 days);
        vm.startPrank(donor);
        usdc.approve(address(c), TARGET);
        c.donate(TARGET, 0, 0);
        vm.stopPrank();
        vm.prank(operator);
        c.setPayoutMode(1);
        c.release(); // T1
        uint256 totalFee = TARGET * cfg.feeBps() / 10_000; // 10 USDC
        assertEq(c.feePaid(), totalFee / 3);
        assertEq(usdc.balanceOf(treasury), totalFee / 3);
        vm.prank(guardian);
        c.freeze();
        vm.prank(guardian);
        c.resolve(false);
        uint256 before = usdc.balanceOf(donor);
        vm.prank(donor);
        c.claimRefund();
        // Everything but T1 and its third of the fee comes back.
        uint256 t1 = (TARGET - totalFee) / 3;
        assertEq(usdc.balanceOf(donor) - before, TARGET - t1 - totalFee / 3);
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
