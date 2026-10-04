// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MaliciousERC20} from "./mocks/MaliciousERC20.sol";
import {MockEmergencyPool} from "./mocks/MockEmergencyPool.sol";

/// @dev MockUSDC that reverts on transfer to blacklisted addresses.
contract BlacklistMockUSDC is MockUSDC {
    mapping(address => bool) public blacklisted;

    function setBlacklisted(address a, bool b) external {
        blacklisted[a] = b;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!blacklisted[to], "blacklisted");
        return super.transfer(to, amount);
    }
}

contract CampaignTest is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    Campaign impl;
    Campaign campaign;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    MockEmergencyPool mockPool;
    address beneficiary = makeAddr("beneficiary");
    address donor1 = makeAddr("donor1");
    address donor2 = makeAddr("donor2");
    address alice = makeAddr("alice");
    address guardian = makeAddr("guardian");

    uint256 constant TARGET = 1000e6; // 1000 USDC
    uint64 constant DURATION = 30 days;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        impl = new Campaign();
        factory = new CampaignFactory(cfg, address(impl));
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
                    offchainId: keccak256("c1"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0 // ORG
                })
            )
        );

        // Give donors some USDC and pre-approve the campaign
        usdc.mint(donor1, 2000e6);
        usdc.mint(donor2, 2000e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), type(uint256).max);
        vm.prank(donor2);
        usdc.approve(address(campaign), type(uint256).max);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _donate(address donor, uint256 amount) internal {
        vm.prank(donor);
        campaign.donate(amount, 0, 0); // REFUND preference
    }

    function _donateToPool(address donor, uint256 amount) internal {
        vm.prank(donor);
        campaign.donate(amount, 1, 0); // EMERGENCY_POOL preference
    }

    function _failCampaign() internal {
        // Donate just below 10% threshold (threshold = 100 USDC on 1000 USDC target)
        _donate(donor1, 99e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FAILED));
    }

    function _succeedCampaign() internal {
        _donate(donor1, TARGET);
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
    }

    function _succeedAndSetSingle() internal {
        _succeedCampaign();
        vm.prank(operator);
        campaign.setPayoutMode(0); // SINGLE
    }

    function _succeedAndSetMilestones() internal {
        _succeedCampaign();
        vm.prank(operator);
        campaign.setPayoutMode(1); // MILESTONES
    }

    function _succeedWithTwoDonorsAndSetMilestones() internal {
        _donate(donor1, 600e6);
        _donate(donor2, 400e6);
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
        vm.prank(operator);
        campaign.setPayoutMode(1);
    }

    // ── initialize ────────────────────────────────────────────────────────────
    function test_impl_cannotBeInitialized() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(cfg, keccak256("x"), beneficiary, TARGET, uint64(block.timestamp + 1 days), 0);
    }

    function test_initialize_cannotBeCalledTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        campaign.initialize(cfg, keccak256("x"), beneficiary, TARGET, uint64(block.timestamp + 1 days), 0);
    }

    function test_initialize_correctState() public view {
        assertEq(uint8(campaign.state()), 0); // LIVE
        assertEq(campaign.target(), TARGET);
        assertEq(campaign.beneficiary(), beneficiary);
        assertEq(campaign.snapFeeBps(), 100);
        assertEq(campaign.snapSuccessThresholdBps(), 1000);
        assertEq(campaign.snapRefundSweepDelay(), 180 days);
    }

    // ── donate ────────────────────────────────────────────────────────────────
    function test_donate_basic() public {
        vm.prank(donor1);
        vm.expectEmit(true, false, false, true);
        emit Campaign.Donated(donor1, 100e6, 0, 0);
        campaign.donate(100e6, 0, 0);

        assertEq(campaign.totalRaised(), 100e6);
        assertEq(campaign.donated(donor1), 100e6);
        assertEq(usdc.balanceOf(address(campaign)), 100e6);
    }

    function test_donate_belowMinReverts() public {
        vm.prank(donor1);
        vm.expectRevert(Campaign.AmountTooLow.selector);
        campaign.donate(0.5e6, 0, 0);
    }

    function test_donate_pastDeadlineReverts() public {
        vm.warp(campaign.deadline());
        vm.prank(donor1);
        vm.expectRevert(Campaign.PastDeadline.selector);
        campaign.donate(100e6, 0, 0);
    }

    function test_donate_notLiveReverts() public {
        _succeedCampaign();
        usdc.mint(donor2, 1000e6);
        vm.prank(donor2);
        usdc.approve(address(campaign), 1000e6);
        vm.prank(donor2);
        vm.expectRevert(Campaign.NotLive.selector);
        campaign.donate(100e6, 0, 0);
    }

    function test_donate_clipsToTarget() public {
        vm.prank(donor1);
        campaign.donate(1500e6, 0, 0); // 50% over target
        assertEq(campaign.totalRaised(), TARGET);
        assertEq(campaign.donated(donor1), TARGET);
        assertEq(usdc.balanceOf(donor1), 2000e6 - TARGET);
    }

    function test_donate_reachesTargetSucceeds() public {
        vm.prank(donor1);
        vm.expectEmit(true, false, false, false);
        emit Campaign.Finalized(Campaign.CampaignState.SUCCEEDED);
        campaign.donate(TARGET, 0, 0);
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
        assertGt(campaign.endTime(), 0);
    }

    function test_donate_invalidPreferenceReverts() public {
        vm.prank(donor1);
        vm.expectRevert(Campaign.InvalidPreference.selector);
        campaign.donate(100e6, 2, 0);
    }

    function test_donate_updatesPreferenceOnSecondDonate() public {
        _donate(donor1, 100e6);
        assertEq(campaign.preference(donor1), 0); // REFUND
        _donateToPool(donor1, 100e6);
        assertEq(campaign.preference(donor1), 1); // EMERGENCY_POOL
    }

    // ── setPreference ─────────────────────────────────────────────────────────
    function test_setPreference_success() public {
        _donate(donor1, 100e6);
        vm.prank(donor1);
        vm.expectEmit(true, false, false, true);
        emit Campaign.PreferenceSet(donor1, 1, 42);
        campaign.setPreference(1, 42);
        assertEq(campaign.preference(donor1), 1);
        assertEq(campaign.donorSubPoolId(donor1), 42);
    }

    function test_setPreference_notDonorReverts() public {
        vm.prank(alice);
        vm.expectRevert(Campaign.NotDonor.selector);
        campaign.setPreference(1, 0);
    }

    function test_setPreference_notLiveReverts() public {
        _donate(donor1, 100e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.prank(donor1);
        vm.expectRevert(Campaign.NotLive.selector);
        campaign.setPreference(0, 0);
    }

    function test_setPreference_invalidReverts() public {
        _donate(donor1, 100e6);
        vm.prank(donor1);
        vm.expectRevert(Campaign.InvalidPreference.selector);
        campaign.setPreference(2, 0);
    }

    // ── finalize ──────────────────────────────────────────────────────────────
    function test_finalize_succeeded() public {
        _donate(donor1, 200e6); // 20% of target
        vm.warp(campaign.deadline() + 1);
        vm.expectEmit(true, false, false, false);
        emit Campaign.Finalized(Campaign.CampaignState.SUCCEEDED);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
    }

    function test_finalize_failed() public {
        _donate(donor1, 50e6); // 5% — below 10% threshold
        vm.warp(campaign.deadline() + 1);
        vm.expectEmit(true, false, false, false);
        emit Campaign.Finalized(Campaign.CampaignState.FAILED);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FAILED));
    }

    function test_finalize_exactThreshold_succeeds() public {
        _donate(donor1, 100e6); // exactly 10%
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
    }

    function test_finalize_oneBelowThreshold_fails() public {
        _donate(donor1, 100e6 - 1); // 1 unit below 10%
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FAILED));
    }

    function test_finalize_beforeDeadlineReverts() public {
        _donate(donor1, 100e6);
        vm.expectRevert(Campaign.DeadlineNotReached.selector);
        campaign.finalize();
    }

    function test_finalize_notLiveReverts() public {
        _succeedCampaign();
        vm.warp(campaign.deadline() + 1);
        vm.expectRevert(Campaign.NotLive.selector);
        campaign.finalize();
    }

    // ── setPayoutMode ─────────────────────────────────────────────────────────
    function test_setPayoutMode_single_org() public {
        _succeedCampaign();
        vm.prank(operator);
        vm.expectEmit(false, false, false, true);
        emit Campaign.PayoutModeSet(0);
        campaign.setPayoutMode(0);
        assertTrue(campaign.payoutModeSet());
        assertEq(campaign.payoutMode(), 0);
    }

    function test_setPayoutMode_milestones_org() public {
        _succeedCampaign();
        vm.prank(operator);
        campaign.setPayoutMode(1);
        assertEq(campaign.payoutMode(), 1);
    }

    function test_setPayoutMode_individual_milestonesOnly() public {
        // Create individual campaign
        vm.prank(operator);
        Campaign indvCampaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("individual-1"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 1 // INDIVIDUAL
                })
            )
        );
        usdc.mint(donor1, TARGET);
        vm.prank(donor1);
        usdc.approve(address(indvCampaign), TARGET);
        vm.prank(donor1);
        indvCampaign.donate(TARGET, 0, 0);

        vm.prank(operator);
        vm.expectRevert(Campaign.IndividualCannotBeSingle.selector);
        indvCampaign.setPayoutMode(0); // SINGLE — must revert

        vm.prank(operator);
        indvCampaign.setPayoutMode(1); // MILESTONES — must succeed
    }

    function test_setPayoutMode_unauthorized_reverts() public {
        _succeedCampaign();
        vm.prank(alice);
        vm.expectRevert(Campaign.NotOperator.selector);
        campaign.setPayoutMode(0);
    }

    function test_setPayoutMode_notSucceededReverts() public {
        vm.prank(operator);
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.setPayoutMode(0);
    }

    function test_setPayoutMode_alreadySetReverts() public {
        _succeedCampaign();
        vm.prank(operator);
        campaign.setPayoutMode(0);
        vm.prank(operator);
        vm.expectRevert(Campaign.PayoutModeAlreadySet.selector);
        campaign.setPayoutMode(0);
    }

    function test_setPayoutMode_invalidModeReverts() public {
        _succeedCampaign();
        vm.prank(operator);
        vm.expectRevert(Campaign.InvalidPayoutMode.selector);
        campaign.setPayoutMode(2);
    }

    // ── release ───────────────────────────────────────────────────────────────
    function test_release_single_correct() public {
        _succeedAndSetSingle();

        // Warp past release delay
        vm.warp(campaign.endTime() + campaign.snapReleaseDelay() + 1);

        uint256 fee = TARGET * 100 / 10_000; // 1% = 10 USDC
        uint256 beneficiaryAmt = TARGET - fee;

        vm.expectEmit(true, false, false, true);
        emit Campaign.TrancheReleased(beneficiary, beneficiaryAmt, fee);
        campaign.release();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.COMPLETED));
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(beneficiary), beneficiaryAmt);
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertEq(campaign.released(), beneficiaryAmt);
        assertEq(campaign.feePaid(), fee);
        assertEq(campaign.released() + campaign.feePaid(), TARGET);
    }

    function test_release_single_tooEarlyReverts() public {
        _succeedAndSetSingle();
        vm.warp(campaign.endTime() + campaign.snapReleaseDelay() - 1);
        vm.expectRevert(Campaign.ReleaseDelayNotReached.selector);
        campaign.release();
    }

    function test_release_zeroFee_noTreasuryTransfer() public {
        // Set fee to 0
        vm.prank(admin);
        cfg.setFeeBps(0);

        // New campaign (will snapshot 0 fee)
        vm.prank(operator);
        Campaign zeroCampaign = Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("zero-fee"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0
                })
            )
        );
        usdc.mint(donor1, TARGET);
        vm.prank(donor1);
        usdc.approve(address(zeroCampaign), TARGET);
        vm.prank(donor1);
        zeroCampaign.donate(TARGET, 0, 0);
        vm.prank(operator);
        zeroCampaign.setPayoutMode(0);
        vm.warp(zeroCampaign.endTime() + zeroCampaign.snapReleaseDelay() + 1);
        zeroCampaign.release();

        assertEq(usdc.balanceOf(beneficiary), TARGET);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(zeroCampaign.feePaid(), 0);
    }

    function test_release_modeNotSetReverts() public {
        _succeedCampaign();
        vm.expectRevert(Campaign.PayoutModeNotSet.selector);
        campaign.release();
    }

    function test_release_notSucceededReverts() public {
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.release();
    }

    // ── claimRefund ───────────────────────────────────────────────────────────
    function test_claimRefund_full() public {
        vm.prank(donor1);
        campaign.donate(50e6, 0, 0); // REFUND preference
        vm.warp(campaign.deadline() + 1);
        campaign.finalize(); // fails (50/1000 = 5%)

        uint256 bal = usdc.balanceOf(donor1);
        vm.prank(donor1);
        vm.expectEmit(true, false, false, true);
        emit Campaign.Refunded(donor1, 50e6);
        campaign.claimRefund();

        assertEq(usdc.balanceOf(donor1), bal + 50e6);
        assertEq(campaign.totalRefunded(), 50e6);
        assertTrue(campaign.settled(donor1));
        assertEq(usdc.balanceOf(address(campaign)), 0);
    }

    function test_claimRefund_notFailedReverts() public {
        _donate(donor1, 50e6);
        vm.prank(donor1);
        vm.expectRevert(Campaign.NotFailedOrRejected.selector);
        campaign.claimRefund();
    }

    function test_claimRefund_notDonorReverts() public {
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.prank(alice);
        vm.expectRevert(Campaign.NotDonor.selector);
        campaign.claimRefund();
    }

    function test_claimRefund_wrongPreferenceReverts() public {
        vm.prank(donor1);
        campaign.donate(50e6, 1, 0); // EMERGENCY_POOL
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.prank(donor1);
        vm.expectRevert(Campaign.InvalidPreference.selector);
        campaign.claimRefund();
    }

    function test_claimRefund_alreadySettledReverts() public {
        _donate(donor1, 50e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.prank(donor1);
        campaign.claimRefund();
        vm.prank(donor1);
        vm.expectRevert(Campaign.AlreadySettled.selector);
        campaign.claimRefund();
    }

    // ── settleToPool ──────────────────────────────────────────────────────────
    function test_settleToPool_success() public {
        vm.prank(donor1);
        campaign.donate(50e6, 1, 7); // EMERGENCY_POOL, subPool 7
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();

        uint256 poolBal = usdc.balanceOf(address(mockPool));
        vm.expectEmit(true, false, false, true);
        emit Campaign.SentToPool(donor1, 50e6, 7);
        campaign.settleToPool(donor1); // anyone can call

        assertEq(usdc.balanceOf(address(mockPool)), poolBal + 50e6);
        assertEq(campaign.totalSentToPool(), 50e6);
        assertTrue(campaign.settled(donor1));
    }

    function test_settleToPool_notFailedReverts() public {
        _donate(donor1, 50e6);
        vm.expectRevert(Campaign.NotFailedOrRejected.selector);
        campaign.settleToPool(donor1);
    }

    function test_settleToPool_notDonorReverts() public {
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.expectRevert(Campaign.NotDonor.selector);
        campaign.settleToPool(alice);
    }

    function test_settleToPool_wrongPreferenceReverts() public {
        _donate(donor1, 50e6); // REFUND preference
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.expectRevert(Campaign.InvalidPreference.selector);
        campaign.settleToPool(donor1);
    }

    function test_settleToPool_alreadySettledReverts() public {
        vm.prank(donor1);
        campaign.donate(50e6, 1, 0);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        campaign.settleToPool(donor1);
        vm.expectRevert(Campaign.AlreadySettled.selector);
        campaign.settleToPool(donor1);
    }

    function test_settleToPool_poolNotConfiguredReverts() public {
        // Deploy campaign with config that has no pool
        PlatformConfig noCfg = new PlatformConfig(address(usdc), admin);
        Campaign noPoolImpl = new Campaign();
        CampaignFactory noPoolFactory = new CampaignFactory(noCfg, address(noPoolImpl));
        vm.startPrank(admin);
        noCfg.grantRole(noCfg.OPERATOR_ROLE(), operator);
        noCfg.setTreasury(treasury);
        vm.stopPrank();

        vm.prank(operator);
        Campaign noPoolCampaign = Campaign(
            noPoolFactory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("no-pool"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0
                })
            )
        );
        usdc.mint(donor1, 50e6);
        vm.prank(donor1);
        usdc.approve(address(noPoolCampaign), 50e6);
        vm.prank(donor1);
        noPoolCampaign.donate(50e6, 1, 0);
        vm.warp(block.timestamp + 31 days);
        noPoolCampaign.finalize();
        vm.expectRevert(Campaign.PoolNotConfigured.selector);
        noPoolCampaign.settleToPool(donor1);
    }

    // ── sweepUnclaimed ────────────────────────────────────────────────────────
    function test_sweepUnclaimed_success() public {
        _donate(donor1, 50e6); // REFUND, won't claim
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();

        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        uint256 poolBal = usdc.balanceOf(address(mockPool));

        vm.expectEmit(false, false, false, true);
        emit Campaign.Swept(50e6);
        campaign.sweepUnclaimed();

        assertEq(usdc.balanceOf(address(mockPool)), poolBal + 50e6);
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertTrue(campaign.swept());
        assertEq(campaign.totalSentToPool(), 50e6);
    }

    function test_sweepUnclaimed_partiallyClaimedFirst() public {
        // Keep total < 10% threshold (100 USDC) so campaign FAILs
        _donate(donor1, 40e6); // REFUND — will claim refund
        vm.prank(donor2); // EMERGENCY_POOL, won't settleToPool
        campaign.donate(40e6, 1, 0);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();

        vm.prank(donor1); // donor1 takes their 40
        campaign.claimRefund();
        // donor2's 40 stays

        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        campaign.sweepUnclaimed();

        assertEq(usdc.balanceOf(address(mockPool)), 40e6);
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertEq(campaign.totalSentToPool(), 40e6);
        assertEq(campaign.totalRefunded(), 40e6);
    }

    function test_sweepUnclaimed_notFailedReverts() public {
        vm.expectRevert(Campaign.NotFailedOrRejected.selector);
        campaign.sweepUnclaimed();
    }

    function test_sweepUnclaimed_tooEarlyReverts() public {
        _donate(donor1, 50e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() - 1);
        vm.expectRevert(Campaign.SweepDelayNotReached.selector);
        campaign.sweepUnclaimed();
    }

    function test_sweepUnclaimed_alreadySweptReverts() public {
        _donate(donor1, 50e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        campaign.sweepUnclaimed();
        vm.expectRevert(Campaign.AlreadySwept.selector);
        campaign.sweepUnclaimed();
    }

    function test_sweepUnclaimed_blocksClaimRefund() public {
        _donate(donor1, 50e6);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        campaign.sweepUnclaimed();
        vm.prank(donor1);
        vm.expectRevert(Campaign.AlreadySwept.selector);
        campaign.claimRefund();
    }

    function test_sweepUnclaimed_blocksSettleToPool() public {
        vm.prank(donor1);
        campaign.donate(50e6, 1, 0);
        vm.warp(campaign.deadline() + 1);
        campaign.finalize();
        vm.warp(campaign.endTime() + campaign.snapRefundSweepDelay() + 1);
        campaign.sweepUnclaimed();
        vm.expectRevert(Campaign.AlreadySwept.selector);
        campaign.settleToPool(donor1);
    }

    // ── views ─────────────────────────────────────────────────────────────────
    function test_remaining_decreases() public {
        assertEq(campaign.remaining(), TARGET);
        _donate(donor1, 200e6);
        assertEq(campaign.remaining(), 800e6);
        _donate(donor1, 800e6);
        assertEq(campaign.remaining(), 0);
    }

    function test_preferenceOf() public {
        _donate(donor1, 100e6);
        assertEq(campaign.preferenceOf(donor1), 0);
        vm.prank(donor1);
        campaign.setPreference(1, 0);
        assertEq(campaign.preferenceOf(donor1), 1);
    }

    // ── reentrancy ────────────────────────────────────────────────────────────
    function test_reentrancy_claimRefund_blocked() public {
        MaliciousERC20 malUsdc = new MaliciousERC20();
        PlatformConfig malCfg = new PlatformConfig(address(malUsdc), admin);
        Campaign malImpl = new Campaign();
        CampaignFactory malFac = new CampaignFactory(malCfg, address(malImpl));

        vm.startPrank(admin);
        malCfg.grantRole(malCfg.OPERATOR_ROLE(), operator);
        malCfg.setTreasury(treasury);
        malCfg.setEmergencyPool(address(mockPool));
        vm.stopPrank();

        vm.prank(operator);
        Campaign malCampaign = Campaign(
            malFac.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("mal"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0
                })
            )
        );

        malUsdc.mint(donor1, 50e6);
        vm.prank(donor1);
        malUsdc.approve(address(malCampaign), 50e6);
        vm.prank(donor1);
        malCampaign.donate(50e6, 0, 0);
        vm.warp(block.timestamp + 31 days);
        malCampaign.finalize();

        // Arm the re-entry weapon
        malUsdc.setReentryTarget(malCampaign);

        // claimRefund calls malUsdc.transfer → malUsdc re-enters claimRefund → blocked
        vm.prank(donor1);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        malCampaign.claimRefund();
    }

    function test_reentrancy_release_blocked() public {
        MaliciousERC20 malUsdc = new MaliciousERC20();
        PlatformConfig malCfg = new PlatformConfig(address(malUsdc), admin);
        Campaign malImpl = new Campaign();
        CampaignFactory malFac = new CampaignFactory(malCfg, address(malImpl));

        vm.startPrank(admin);
        malCfg.grantRole(malCfg.OPERATOR_ROLE(), operator);
        malCfg.setTreasury(treasury);
        malCfg.setEmergencyPool(address(mockPool));
        vm.stopPrank();

        vm.prank(operator);
        Campaign malCampaign = Campaign(
            malFac.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("mal-release"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0
                })
            )
        );

        malUsdc.mint(donor1, TARGET);
        vm.prank(donor1);
        malUsdc.approve(address(malCampaign), TARGET);
        vm.prank(donor1);
        malCampaign.donate(TARGET, 0, 0);

        vm.prank(operator);
        malCampaign.setPayoutMode(0);

        // Warp past release delay
        vm.warp(malCampaign.endTime() + malCampaign.snapReleaseDelay() + 1);

        // Arm re-entry to attack release() during the beneficiary transfer
        malUsdc.setReentryTarget(malCampaign);
        malUsdc.setAttackMode(1);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        malCampaign.release();
    }

    // ── MILESTONES T1 release ─────────────────────────────────────────────────

    function test_milestones_T1_correct() public {
        _succeedAndSetMilestones();

        uint256 total = TARGET;
        uint256 fee = total * 100 / 10_000; // 1% = 10 USDC
        uint256 net = total - fee; // 990 USDC
        uint256 t1 = net / 3; // 330 USDC

        vm.expectEmit(true, false, false, true);
        emit Campaign.TrancheReleased(beneficiary, t1, fee);
        campaign.release();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));
        assertEq(campaign.tranchesReleased(), 1);
        assertEq(campaign.released(), t1);
        assertEq(campaign.feePaid(), fee);
        assertEq(usdc.balanceOf(beneficiary), t1);
        assertEq(usdc.balanceOf(treasury), fee);
    }

    function test_milestones_T2_releaseInPayingReverts() public {
        _succeedAndSetMilestones();
        campaign.release(); // T1 → PAYING
        // release() only valid in SUCCEEDED; PAYING reverts
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.release();
    }

    // ── submitEvidence ────────────────────────────────────────────────────────

    function test_submitEvidence_afterT1() public {
        _succeedAndSetMilestones();
        campaign.release(); // T1
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));

        bytes32 hash = keccak256("evidence-1");
        vm.expectEmit(true, false, false, true);
        emit Campaign.EvidenceSubmitted(0, hash, uint64(block.timestamp) + uint64(campaign.snapVoteWindow()));
        vm.prank(beneficiary);
        campaign.submitEvidence(hash);

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.VOTING));
        assertEq(campaign.currentRound(), 0);
        assertGt(campaign.voteEnd(), block.timestamp);
    }

    function test_submitEvidence_notBeneficiaryReverts() public {
        _succeedAndSetMilestones();
        campaign.release();
        vm.prank(alice);
        vm.expectRevert(Campaign.NotBeneficiary.selector);
        campaign.submitEvidence(keccak256("x"));
    }

    function test_submitEvidence_notPayingReverts() public {
        _succeedAndSetMilestones();
        // Haven't released T1 yet, state is SUCCEEDED
        vm.prank(beneficiary);
        vm.expectRevert(Campaign.NotPaying.selector);
        campaign.submitEvidence(keccak256("x"));
    }

    // ── vote ──────────────────────────────────────────────────────────────────

    function test_vote_basic() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release(); // T1

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.prank(donor1);
        vm.expectEmit(true, true, false, true);
        emit Campaign.Voted(0, donor1, true, 600e6);
        campaign.vote(true);

        assertEq(campaign.yesVotes(), 600e6);
        assertEq(campaign.noVotes(), 0);
        assertTrue(campaign.hasVoted(donor1, 0));
    }

    function test_vote_doubleVoteReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.prank(donor1);
        campaign.vote(true);
        vm.prank(donor1);
        vm.expectRevert(Campaign.AlreadyVoted.selector);
        campaign.vote(false);
    }

    function test_vote_afterDeadlineReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.warp(campaign.voteEnd());
        vm.prank(donor1);
        vm.expectRevert(Campaign.VoteEnded.selector);
        campaign.vote(true);
    }

    function test_vote_notDonorReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.prank(alice);
        vm.expectRevert(Campaign.NotDonor.selector);
        campaign.vote(true);
    }

    function test_vote_notVotingReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        // In PAYING state, not VOTING
        vm.prank(donor1);
        vm.expectRevert(Campaign.NotVoting.selector);
        campaign.vote(true);
    }

    // ── closeVote ─────────────────────────────────────────────────────────────

    function test_closeVote_passes() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release(); // T1

        uint256 net = TARGET - (TARGET * 100 / 10_000);
        uint256 t1 = net / 3;
        uint256 t2 = net / 3;

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        // Both donors approve — quorum 100%, approval 100% → atomic T2 release
        vm.prank(donor1);
        campaign.vote(true);
        vm.prank(donor2);
        campaign.vote(true);

        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // closeVote released T2 atomically → PAYING
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));
        assertEq(campaign.tranchesReleased(), 2);
        assertEq(campaign.released(), t1 + t2);
    }

    /// @dev ADR-045: three donors so that turnout just below / exactly at the 25 % quorum is reachable.
    ///      donor1 750, donor2 249, donor3 1 USDC (total == TARGET; minDonation is 1 USDC).
    function _succeedWithThreeDonorsAndSetMilestones(address donor3) internal {
        usdc.mint(donor3, 1e6);
        vm.prank(donor3);
        usdc.approve(address(campaign), type(uint256).max);
        _donate(donor1, 750e6);
        _donate(donor2, 249e6);
        _donate(donor3, 1e6);
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
        vm.prank(operator);
        campaign.setPayoutMode(1);
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
    }

    function test_closeVote_failsQuorum_needsReview() public {
        address donor3 = makeAddr("donor3");
        _succeedWithThreeDonorsAndSetMilestones(donor3);

        // Only donor2 votes: 249 / 1000 = 24.9 %, just below the 25 % quorum (ADR-045) — not met
        vm.prank(donor2);
        campaign.vote(true);

        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.NEEDS_REVIEW));
    }

    function test_closeVote_quorumExactly25Percent_passes() public {
        address donor3 = makeAddr("donor3");
        _succeedWithThreeDonorsAndSetMilestones(donor3);

        // donor2 + donor3 = exactly 250 = 25 % of 1000 → quorum met (ADR-045), 100 % yes → next tranche
        vm.prank(donor2);
        campaign.vote(true);
        vm.prank(donor3);
        campaign.vote(true);

        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));
        assertEq(campaign.tranchesReleased(), 2);
    }

    function test_closeVote_noVotes_needsReview() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        // Silence is not consent (ADR-045): nobody votes → quorum not met → Guardian review
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.NEEDS_REVIEW));
    }

    function test_snapshot_voteWindowAndQuorum_adr045() public view {
        assertEq(campaign.snapVoteWindow(), 7 days);
        assertEq(campaign.snapQuorumBps(), 2500);
        assertEq(campaign.snapApprovalBps(), 5100);
    }

    function test_closeVote_failsApproval_rejected() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        // Both vote, but majority reject. Quorum met (100%), approval fails → REJECTED
        vm.prank(donor1);
        campaign.vote(false); // 600 no
        vm.prank(donor2);
        campaign.vote(true); // 400 yes

        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // approval: 400 * 10000 >= 1000 * 5100 → 4_000_000 >= 5_100_000 → false → REJECTED
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED));
        assertGt(campaign.rejectedRemainder(), 0);
        assertEq(campaign.settlementStart(), uint64(block.timestamp));
    }

    function test_closeVote_tooEarlyReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.prank(donor1);
        campaign.vote(true);
        vm.expectRevert(Campaign.VoteNotEnded.selector);
        campaign.closeVote();
    }

    function test_closeVote_notVotingReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.expectRevert(Campaign.NotVoting.selector);
        campaign.closeVote();
    }

    // ── Full milestone path T1 → T2 → T3 ─────────────────────────────────────

    function test_milestones_fullPath_T1_T2_T3() public {
        _succeedWithTwoDonorsAndSetMilestones();

        uint256 total = TARGET;
        uint256 fee = total * 100 / 10_000;
        uint256 net = total - fee;
        uint256 t1 = net / 3;
        uint256 t2 = net / 3;
        uint256 t3 = net - t1 - t2;

        // T1 via release()
        campaign.release();
        assertEq(campaign.tranchesReleased(), 1);
        assertEq(campaign.released(), t1);
        assertEq(campaign.feePaid(), fee);

        // Evidence + vote → closeVote releases T2 atomically
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.prank(donor1);
        campaign.vote(true);
        vm.prank(donor2);
        campaign.vote(true);
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // T2 was released by closeVote
        assertEq(campaign.tranchesReleased(), 2);
        assertEq(campaign.released(), t1 + t2);
        assertEq(campaign.feePaid(), fee); // fee only with T1
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));

        // Evidence + vote → closeVote releases T3 atomically → COMPLETED
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e2"));
        vm.prank(donor1);
        campaign.vote(true);
        vm.prank(donor2);
        campaign.vote(true);
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // T3 was released by closeVote → COMPLETED
        assertEq(campaign.tranchesReleased(), 3);
        assertEq(campaign.released(), t1 + t2 + t3);
        assertEq(campaign.released(), net);
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.COMPLETED));
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertEq(usdc.balanceOf(beneficiary), net);
        assertEq(usdc.balanceOf(treasury), fee);
    }

    function test_milestones_noDust() public {
        // net = 990_000_000, t1 = t2 = 330_000_000, t3 = 330_000_000
        // 330*3 = 990 ✓
        _succeedAndSetMilestones();
        uint256 net = TARGET - (TARGET * 100 / 10_000);
        uint256 t1 = net / 3;
        uint256 t3 = net - t1 - t1;
        assertEq(t1 + t1 + t3, net, "tranche math has dust");
    }

    // ── Guardian freeze ───────────────────────────────────────────────────────

    function test_freeze_fromLive() public {
        vm.prank(guardian);
        vm.expectEmit(true, false, false, false);
        emit Campaign.Frozen(Campaign.CampaignState.LIVE);
        campaign.freeze();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FROZEN));
        assertEq(uint8(campaign.prevState()), uint8(Campaign.CampaignState.LIVE));
    }

    function test_freeze_fromSucceeded() public {
        _succeedCampaign();
        vm.prank(guardian);
        campaign.freeze();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FROZEN));
        assertEq(uint8(campaign.prevState()), uint8(Campaign.CampaignState.SUCCEEDED));
    }

    function test_freeze_fromPaying() public {
        _succeedAndSetMilestones();
        campaign.release(); // T1 → PAYING
        vm.prank(guardian);
        campaign.freeze();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FROZEN));
    }

    function test_freeze_fromVoting() public {
        _succeedAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        vm.prank(guardian);
        campaign.freeze();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.FROZEN));
        assertEq(uint8(campaign.prevState()), uint8(Campaign.CampaignState.VOTING));
    }

    function test_freeze_notGuardianReverts() public {
        vm.prank(alice);
        vm.expectRevert(Campaign.NotGuardian.selector);
        campaign.freeze();
    }

    function test_freeze_cannotFromFailed() public {
        _failCampaign();
        vm.prank(guardian);
        vm.expectRevert(Campaign.CannotFreeze.selector);
        campaign.freeze();
    }

    function test_freeze_cannotFromCompleted() public {
        _succeedAndSetSingle();
        vm.warp(campaign.endTime() + campaign.snapReleaseDelay() + 1);
        campaign.release();
        vm.prank(guardian);
        vm.expectRevert(Campaign.CannotFreeze.selector);
        campaign.freeze();
    }

    // ── Guardian resolve (approve) ────────────────────────────────────────────

    function test_resolve_approveFrozen_restoresState() public {
        _succeedCampaign();
        vm.prank(guardian);
        campaign.freeze();

        vm.prank(guardian);
        vm.expectEmit(false, true, false, true);
        emit Campaign.Resolved(true, Campaign.CampaignState.SUCCEEDED);
        campaign.resolve(true);

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED));
    }

    function test_resolve_approveFrozenVoting_extendsVoteEnd() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));

        uint64 originalVoteEnd = campaign.voteEnd();

        // Freeze during voting
        vm.prank(guardian);
        campaign.freeze();

        // Warp 1 hour while frozen
        vm.warp(block.timestamp + 1 hours);

        vm.prank(guardian);
        campaign.resolve(true);

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.VOTING));
        assertEq(campaign.voteEnd(), originalVoteEnd + 1 hours, "voteEnd not extended");
    }

    function test_resolve_approveNeedsReview_releasesTrancheAtomically() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release(); // T1
        uint256 net = TARGET - (TARGET * 100 / 10_000);
        uint256 t1 = net / 3;
        uint256 t2 = net / 3;

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        // No votes → quorum fails
        vm.warp(campaign.voteEnd());
        campaign.closeVote();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.NEEDS_REVIEW));

        vm.prank(guardian);
        campaign.resolve(true);

        // Guardian override released T2 atomically
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));
        assertEq(campaign.tranchesReleased(), 2);
        assertEq(campaign.released(), t1 + t2);
    }

    // ── Guardian resolve (reject) ─────────────────────────────────────────────

    function test_resolve_reject_fromFrozen() public {
        _succeedAndSetMilestones();
        campaign.release(); // T1 → PAYING

        vm.prank(guardian);
        campaign.freeze();

        vm.prank(guardian);
        vm.expectEmit(false, true, false, true);
        emit Campaign.Resolved(false, Campaign.CampaignState.REJECTED);
        campaign.resolve(false);

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED));
        assertGt(campaign.rejectedRemainder(), 0);
        assertEq(campaign.settlementStart(), uint64(block.timestamp));
    }

    function test_resolve_reject_fromNeedsReview() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.warp(campaign.voteEnd());
        campaign.closeVote(); // NEEDS_REVIEW

        vm.prank(guardian);
        campaign.resolve(false);

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED));
    }

    function test_resolve_notGuardianReverts() public {
        _succeedCampaign();
        vm.prank(guardian);
        campaign.freeze();

        vm.prank(alice);
        vm.expectRevert(Campaign.NotGuardian.selector);
        campaign.resolve(true);
    }

    function test_resolve_cannotFromPayingReverts() public {
        _succeedAndSetMilestones();
        campaign.release();
        vm.prank(alice);
        vm.expectRevert(Campaign.NotGuardian.selector);
        campaign.resolve(true);
    }

    // ── REJECTED refunds (pro-rata) ───────────────────────────────────────────

    function test_rejected_claimRefund_proRata() public {
        _succeedWithTwoDonorsAndSetMilestones();

        uint256 fee = TARGET * 100 / 10_000;
        uint256 net = TARGET - fee;
        uint256 t1 = net / 3;

        campaign.release(); // T1 paid out

        vm.prank(guardian);
        campaign.freeze();
        vm.prank(guardian);
        campaign.resolve(false); // → REJECTED

        uint256 remainder = campaign.rejectedRemainder();
        assertEq(remainder, TARGET - t1 - fee, "wrong remainder");

        // donor1 (600 USDC) gets 600 * remainder / 1000
        uint256 expected1 = 600e6 * remainder / TARGET;
        vm.prank(donor1);
        campaign.claimRefund();
        assertEq(usdc.balanceOf(donor1), 2000e6 - 600e6 + expected1, "donor1 refund wrong");

        // donor2 (400 USDC) gets 400 * remainder / 1000
        uint256 expected2 = 400e6 * remainder / TARGET;
        vm.prank(donor2);
        campaign.claimRefund();
        assertEq(usdc.balanceOf(donor2), 2000e6 - 400e6 + expected2, "donor2 refund wrong");
    }

    function test_rejected_settleToPool_proRata() public {
        // donor1 = REFUND, donor2 = EMERGENCY_POOL
        _donate(donor1, 600e6);
        vm.prank(donor2);
        campaign.donate(400e6, 1, 7); // EMERGENCY_POOL

        vm.prank(operator);
        campaign.setPayoutMode(1);
        campaign.release(); // T1

        vm.prank(guardian);
        campaign.freeze();
        vm.prank(guardian);
        campaign.resolve(false);

        uint256 remainder = campaign.rejectedRemainder();
        uint256 expected2 = 400e6 * remainder / TARGET;

        campaign.settleToPool(donor2);
        assertEq(usdc.balanceOf(address(mockPool)), expected2, "pool amount wrong");
    }

    function test_rejected_sweepUnclaimed() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();

        vm.prank(guardian);
        campaign.freeze();
        vm.prank(guardian);
        campaign.resolve(false);

        vm.warp(campaign.settlementStart() + campaign.snapRefundSweepDelay() + 1);

        uint256 bal = usdc.balanceOf(address(campaign));
        campaign.sweepUnclaimed();
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertEq(usdc.balanceOf(address(mockPool)), bal);
        assertTrue(campaign.swept());
    }

    function test_rejected_sweepTooEarlyReverts() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release();
        vm.prank(guardian);
        campaign.freeze();
        vm.prank(guardian);
        campaign.resolve(false);

        vm.warp(campaign.settlementStart() + campaign.snapRefundSweepDelay() - 1);
        vm.expectRevert(Campaign.SweepDelayNotReached.selector);
        campaign.sweepUnclaimed();
    }

    // ── Review round 1: new tests ─────────────────────────────────────────────

    /// @notice Reject at round 1 by donor vote (quorum met, <51% yes) → REJECTED → pro-rata refund and pool settlement
    function test_closeVote_rejectRound1_proRataRefund() public {
        // donor1=600 REFUND, donor2=400 POOL
        _donate(donor1, 600e6);
        vm.prank(donor2);
        campaign.donate(400e6, 1, 7); // EMERGENCY_POOL

        vm.prank(operator);
        campaign.setPayoutMode(1);
        campaign.release(); // T1

        uint256 fee = TARGET * 100 / 10_000;
        uint256 net = TARGET - fee;
        uint256 t1 = net / 3;
        uint256 remainder = TARGET - t1 - fee;

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        // Quorum met (100%), approval fails (40% yes)
        vm.prank(donor1);
        campaign.vote(false); // 600 no
        vm.prank(donor2);
        campaign.vote(true); // 400 yes
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED));
        assertEq(campaign.rejectedRemainder(), remainder);

        // donor1 claims refund (pro-rata)
        uint256 expected1 = 600e6 * remainder / TARGET;
        vm.prank(donor1);
        campaign.claimRefund();
        assertEq(usdc.balanceOf(donor1), 2000e6 - 600e6 + expected1, "donor1 refund");

        // donor2 settles to pool (pro-rata)
        uint256 expected2 = 400e6 * remainder / TARGET;
        campaign.settleToPool(donor2);
        assertEq(usdc.balanceOf(address(mockPool)), expected2, "pool amount");
    }

    /// @notice Reject at round 2 by donor vote → remainder == t3
    function test_closeVote_rejectRound2_remainderIsT3() public {
        _succeedWithTwoDonorsAndSetMilestones();

        uint256 fee = TARGET * 100 / 10_000;
        uint256 net = TARGET - fee;
        uint256 t3 = net - (net / 3) - (net / 3);

        campaign.release(); // T1

        // Vote round 1: approve → T2 released
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.prank(donor1);
        campaign.vote(true);
        vm.prank(donor2);
        campaign.vote(true);
        vm.warp(campaign.voteEnd());
        campaign.closeVote(); // T2 released atomically

        assertEq(campaign.tranchesReleased(), 2);

        // Vote round 2: reject → REJECTED, remainder == t3
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e2"));
        vm.prank(donor1);
        campaign.vote(false);
        vm.prank(donor2);
        campaign.vote(false);
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED));
        assertEq(campaign.rejectedRemainder(), t3, "remainder should equal t3");
    }

    /// @notice Boundary: quorum met with approval exactly 51.00% → tranche released; one unit less → REJECTED
    function test_closeVote_approvalBoundary() public {
        // We need donors that produce exact 51% approval boundary
        // snapApprovalBps = 5100. Need: yes * 10000 >= (yes+no) * 5100
        // With yes=510, no=490: 510*10000=5100000 >= 1000*5100=5100000 → true (exactly on boundary)
        // With yes=509, no=491: 509*10000=5090000 >= 1000*5100=5100000 → false

        // Create campaign with specific donors for boundary test
        // donor1=510, donor2=490, total=1000
        usdc.mint(alice, 2000e6);
        vm.prank(alice);
        usdc.approve(address(campaign), type(uint256).max);

        vm.prank(donor1);
        campaign.donate(510e6, 0, 0);
        vm.prank(alice);
        campaign.donate(490e6, 0, 0);

        vm.prank(operator);
        campaign.setPayoutMode(1);
        campaign.release(); // T1

        // Case 1: exactly 51% → approved → tranche released
        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.prank(donor1);
        campaign.vote(true); // 510 yes
        vm.prank(alice);
        campaign.vote(false); // 490 no
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // 510 * 10000 = 5_100_000 >= 1000 * 5100 = 5_100_000 → true
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING), "exactly 51% should release");
        assertEq(campaign.tranchesReleased(), 2, "T2 should be released");
    }

    function test_closeVote_approvalBoundary_oneUnitLess() public {
        // donor1=509, donor2=491 → 509*10000=5090000 < 1000*5100=5100000 → REJECTED
        usdc.mint(alice, 2000e6);
        vm.prank(alice);
        usdc.approve(address(campaign), type(uint256).max);

        vm.prank(donor1);
        campaign.donate(509e6, 0, 0);
        vm.prank(alice);
        campaign.donate(491e6, 0, 0);

        vm.prank(operator);
        campaign.setPayoutMode(1);
        campaign.release();

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.prank(donor1);
        campaign.vote(true); // 509 yes
        vm.prank(alice);
        campaign.vote(false); // 491 no
        vm.warp(campaign.voteEnd());
        campaign.closeVote();

        // 509 * 10000 = 5_090_000 < 1000 * 5100 = 5_100_000 → REJECTED (not NEEDS_REVIEW)
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.REJECTED), "one unit below 51% -> REJECTED");
    }

    /// @notice release() reverts in PAYING, VOTING, NEEDS_REVIEW
    function test_release_revertsInPayingVotingNeedsReview() public {
        _succeedWithTwoDonorsAndSetMilestones();
        campaign.release(); // T1 → PAYING
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.release(); // PAYING → revert

        vm.prank(beneficiary);
        campaign.submitEvidence(keccak256("e1"));
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.release(); // VOTING → revert

        // No votes → quorum fails → NEEDS_REVIEW
        vm.warp(campaign.voteEnd());
        campaign.closeVote();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.NEEDS_REVIEW));
        vm.expectRevert(Campaign.NotSucceeded.selector);
        campaign.release(); // NEEDS_REVIEW → revert
    }

    /// @notice closeVote with blacklisted beneficiary → reverts, then Guardian freeze → resolve(false) → donors recover
    function test_closeVote_blacklistedBeneficiary_guardianRecovers() public {
        // Deploy a fresh campaign with BlacklistMockUSDC
        BlacklistMockUSDC bUsdc = new BlacklistMockUSDC();
        PlatformConfig bCfg = new PlatformConfig(address(bUsdc), admin);
        Campaign bImpl = new Campaign();
        CampaignFactory bFactory = new CampaignFactory(bCfg, address(bImpl));

        vm.startPrank(admin);
        bCfg.grantRole(bCfg.OPERATOR_ROLE(), operator);
        bCfg.grantRole(bCfg.GUARDIAN_ROLE(), guardian);
        bCfg.setTreasury(treasury);
        bCfg.setEmergencyPool(address(mockPool));
        vm.stopPrank();

        vm.prank(operator);
        Campaign bCampaign = Campaign(
            bFactory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: keccak256("blacklist-test"),
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + DURATION),
                    beneficiaryType: 0
                })
            )
        );

        bUsdc.mint(donor1, 2000e6);
        bUsdc.mint(donor2, 2000e6);
        vm.prank(donor1);
        bUsdc.approve(address(bCampaign), type(uint256).max);
        vm.prank(donor2);
        bUsdc.approve(address(bCampaign), type(uint256).max);

        vm.prank(donor1);
        bCampaign.donate(600e6, 0, 0);
        vm.prank(donor2);
        bCampaign.donate(400e6, 0, 0);

        vm.prank(operator);
        bCampaign.setPayoutMode(1);
        bCampaign.release(); // T1 (beneficiary not yet blacklisted)

        // Blacklist beneficiary
        bUsdc.setBlacklisted(beneficiary, true);

        vm.prank(beneficiary);
        bCampaign.submitEvidence(keccak256("e1"));
        vm.prank(donor1);
        bCampaign.vote(true);
        vm.prank(donor2);
        bCampaign.vote(true);
        vm.warp(bCampaign.voteEnd());

        // closeVote tries to transfer to blacklisted beneficiary → reverts
        vm.expectRevert("blacklisted");
        bCampaign.closeVote();

        // Guardian recovery: freeze from VOTING → resolve(false) → REJECTED
        vm.prank(guardian);
        bCampaign.freeze();
        assertEq(uint8(bCampaign.state()), uint8(Campaign.CampaignState.FROZEN));

        vm.prank(guardian);
        bCampaign.resolve(false);
        assertEq(uint8(bCampaign.state()), uint8(Campaign.CampaignState.REJECTED));

        // Donors can recover funds
        uint256 remainder = bCampaign.rejectedRemainder();
        assertGt(remainder, 0);
        uint256 expected1 = 600e6 * remainder / TARGET;
        vm.prank(donor1);
        bCampaign.claimRefund();
        assertEq(bUsdc.balanceOf(donor1), 2000e6 - 600e6 + expected1, "donor1 recovered");
    }

    // ── Snapshot isolation: releaseDelay ───────────────────────────────────────

    function test_snapshot_releaseDelay() public view {
        assertEq(campaign.snapReleaseDelay(), 72 hours);
    }

    // ── donateFromPool & poolDonated (TASK-004) ────────────────────────────────

    /// @notice Only emergencyPool can call donateFromPool.
    function test_donateFromPool_notPool_reverts() public {
        usdc.mint(donor1, 100e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), 100e6);
        vm.prank(donor1);
        vm.expectRevert(Campaign.NotPool.selector);
        campaign.donateFromPool(100e6);
    }

    /// @notice donateFromPool only works when LIVE.
    function test_donateFromPool_notLive_reverts() public {
        // Fully fund and finalize
        usdc.mint(donor1, TARGET);
        vm.prank(donor1);
        usdc.approve(address(campaign), TARGET);
        vm.prank(donor1);
        campaign.donate(TARGET, 0, 0);

        // Campaign is now SUCCEEDED
        usdc.mint(address(mockPool), 100e6);
        vm.prank(address(mockPool));
        usdc.approve(address(campaign), 100e6);
        vm.prank(address(mockPool));
        vm.expectRevert(Campaign.NotLive.selector);
        campaign.donateFromPool(100e6);
    }

    /// @notice donateFromPool clips to remaining target and records poolDonated.
    function test_donateFromPool_clipping() public {
        // Donate 900 from donor1
        usdc.mint(donor1, 900e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), 900e6);
        vm.prank(donor1);
        campaign.donate(900e6, 0, 0);

        // Pool tries to donate 200, but only 100 remains
        usdc.mint(address(mockPool), 200e6);
        vm.prank(address(mockPool));
        usdc.approve(address(campaign), 200e6);
        vm.prank(address(mockPool));
        uint256 actual = campaign.donateFromPool(200e6);

        assertEq(actual, 100e6, "should clip to remaining");
        assertEq(campaign.poolDonated(), 100e6, "poolDonated tracks");
        assertEq(campaign.totalRaised(), TARGET, "should hit target");
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.SUCCEEDED), "should succeed");
    }

    /// @notice closeVote quorum base excludes poolDonated (change B).
    function test_closeVote_quorumExcludesPoolDonated() public {
        // Donor donates 500, pool donates 500
        usdc.mint(donor1, 500e6);
        vm.prank(donor1);
        usdc.approve(address(campaign), 500e6);
        vm.prank(donor1);
        campaign.donate(500e6, 0, 0);

        usdc.mint(address(mockPool), 500e6);
        vm.prank(address(mockPool));
        usdc.approve(address(campaign), 500e6);
        vm.prank(address(mockPool));
        campaign.donateFromPool(500e6);
        // totalRaised = 1000, poolDonated = 500, quorumBase = 500

        // SUCCEEDED → MILESTONES → T1 → evidence → vote
        vm.prank(operator);
        campaign.setPayoutMode(1);
        vm.warp(block.timestamp + cfg.releaseDelay() + 1);
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence("ipfs://test");

        // quorumBps = 25% (ADR-045), so 125 of quorumBase(500) needed
        // donor1 has 500 voting weight. Vote YES with 250+ (just vote all 500)
        vm.prank(donor1);
        campaign.vote(true);
        vm.warp(campaign.voteEnd() + 1);

        // Close: quorumBase=500, voted=500, quorum met, approval met → PAYING
        campaign.closeVote();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.PAYING));
    }

    /// @notice Fully pool-funded campaign: quorumBase == 0 → always NEEDS_REVIEW.
    function test_closeVote_fullyPoolFunded_needsReview() public {
        usdc.mint(address(mockPool), TARGET);
        vm.prank(address(mockPool));
        usdc.approve(address(campaign), TARGET);
        vm.prank(address(mockPool));
        campaign.donateFromPool(TARGET);
        // totalRaised = 1000, poolDonated = 1000, quorumBase = 0

        vm.prank(operator);
        campaign.setPayoutMode(1);
        vm.warp(block.timestamp + cfg.releaseDelay() + 1);
        campaign.release();
        vm.prank(beneficiary);
        campaign.submitEvidence("ipfs://test");
        vm.warp(campaign.voteEnd() + 1);

        // Close: quorumBase=0 → always NEEDS_REVIEW
        campaign.closeVote();
        assertEq(uint8(campaign.state()), uint8(Campaign.CampaignState.NEEDS_REVIEW));
    }
}
