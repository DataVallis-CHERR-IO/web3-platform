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

contract CampaignTest is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    Campaign impl;
    Campaign campaign;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    address pool = makeAddr("pool");
    address beneficiary = makeAddr("beneficiary");
    address donor1 = makeAddr("donor1");
    address donor2 = makeAddr("donor2");
    address alice = makeAddr("alice");

    uint256 constant TARGET = 1000e6; // 1000 USDC
    uint64 constant DURATION = 30 days;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        impl = new Campaign();
        factory = new CampaignFactory(cfg, address(impl));

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(pool);
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

    function test_release_milestonesReverts() public {
        _succeedCampaign();
        vm.prank(operator);
        campaign.setPayoutMode(1);
        vm.expectRevert(Campaign.NotImplemented.selector);
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
        vm.expectRevert(Campaign.NotFailed.selector);
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

        uint256 poolBal = usdc.balanceOf(pool);
        vm.expectEmit(true, false, false, true);
        emit Campaign.SentToPool(donor1, 50e6, 7);
        campaign.settleToPool(donor1); // anyone can call

        assertEq(usdc.balanceOf(pool), poolBal + 50e6);
        assertEq(campaign.totalSentToPool(), 50e6);
        assertTrue(campaign.settled(donor1));
    }

    function test_settleToPool_notFailedReverts() public {
        _donate(donor1, 50e6);
        vm.expectRevert(Campaign.NotFailed.selector);
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
        uint256 poolBal = usdc.balanceOf(pool);

        vm.expectEmit(false, false, false, true);
        emit Campaign.Swept(50e6);
        campaign.sweepUnclaimed();

        assertEq(usdc.balanceOf(pool), poolBal + 50e6);
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

        assertEq(usdc.balanceOf(pool), 40e6);
        assertEq(usdc.balanceOf(address(campaign)), 0);
        assertEq(campaign.totalSentToPool(), 40e6);
        assertEq(campaign.totalRefunded(), 40e6);
    }

    function test_sweepUnclaimed_notFailedReverts() public {
        vm.expectRevert(Campaign.NotFailed.selector);
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
        malCfg.setEmergencyPool(pool);
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
        malCfg.setEmergencyPool(pool);
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

        // Arm re-entry to attack release() during the beneficiary transfer
        malUsdc.setReentryTarget(malCampaign);
        malUsdc.setAttackMode(1);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        malCampaign.release();
    }
}
