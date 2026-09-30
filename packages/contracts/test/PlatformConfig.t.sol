// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PlatformConfigTest is Test {
    PlatformConfig cfg;
    MockUSDC usdc;
    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address alice = makeAddr("alice");

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    function test_constructor_defaults() public view {
        assertEq(cfg.feeBps(), 100);
        assertEq(cfg.successThresholdBps(), 1000);
        assertEq(cfg.voteWindow(), 24 hours);
        assertEq(cfg.quorumBps(), 5000);
        assertEq(cfg.approvalBps(), 5100);
        assertEq(cfg.refundSweepDelay(), 180 days);
        assertEq(cfg.minDonation(), 1e6);
        assertEq(cfg.usdc(), address(usdc));
        assertTrue(cfg.hasRole(cfg.DEFAULT_ADMIN_ROLE(), admin));
    }

    function test_constructor_zeroUsdc_reverts() public {
        vm.expectRevert(PlatformConfig.ZeroAddress.selector);
        new PlatformConfig(address(0), admin);
    }

    function test_constructor_zeroAdmin_reverts() public {
        vm.expectRevert(PlatformConfig.ZeroAddress.selector);
        new PlatformConfig(address(usdc), address(0));
    }

    // ── setTreasury ───────────────────────────────────────────────────────────
    function test_setTreasury_success() public {
        address t = makeAddr("treasury");
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit PlatformConfig.TreasuryUpdated(address(0), t);
        cfg.setTreasury(t);
        assertEq(cfg.treasury(), t);
    }

    function test_setTreasury_zeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.ZeroAddress.selector);
        cfg.setTreasury(address(0));
    }

    function test_setTreasury_unauthorized() public {
        vm.prank(alice);
        vm.expectRevert();
        cfg.setTreasury(makeAddr("t"));
    }

    // ── setEmergencyPool ──────────────────────────────────────────────────────
    function test_setEmergencyPool_success() public {
        address pool = makeAddr("pool");
        vm.prank(admin);
        vm.expectEmit(true, true, false, false);
        emit PlatformConfig.EmergencyPoolUpdated(address(0), pool);
        cfg.setEmergencyPool(pool);
        assertEq(cfg.emergencyPool(), pool);
    }

    function test_setEmergencyPool_canBeUpdated() public {
        address pool1 = makeAddr("pool1");
        address pool2 = makeAddr("pool2");
        vm.startPrank(admin);
        cfg.setEmergencyPool(pool1);
        cfg.setEmergencyPool(pool2); // updatable (protected by 48h timelock in production)
        vm.stopPrank();
        assertEq(cfg.emergencyPool(), pool2);
    }

    function test_setEmergencyPool_zeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.ZeroAddress.selector);
        cfg.setEmergencyPool(address(0));
    }

    function test_setEmergencyPool_unauthorized() public {
        vm.prank(alice);
        vm.expectRevert();
        cfg.setEmergencyPool(makeAddr("pool"));
    }

    // ── setFeeBps ─────────────────────────────────────────────────────────────
    function test_setFeeBps_success() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.FeeBpsUpdated(100, 200);
        cfg.setFeeBps(200);
        assertEq(cfg.feeBps(), 200);
    }

    function test_setFeeBps_max() public {
        vm.prank(admin);
        cfg.setFeeBps(500);
        assertEq(cfg.feeBps(), 500);
    }

    function test_setFeeBps_tooHigh_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.FeeTooHigh.selector);
        cfg.setFeeBps(501);
    }

    function test_setFeeBps_unauthorized() public {
        vm.prank(operator);
        vm.expectRevert();
        cfg.setFeeBps(50);
    }

    // ── setSuccessThresholdBps ────────────────────────────────────────────────
    function test_setSuccessThresholdBps() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.SuccessThresholdBpsUpdated(1000, 500);
        cfg.setSuccessThresholdBps(500);
        assertEq(cfg.successThresholdBps(), 500);
    }

    function test_setSuccessThresholdBps_zero_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.SuccessThresholdOutOfRange.selector);
        cfg.setSuccessThresholdBps(0);
    }

    function test_setSuccessThresholdBps_above10000_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.SuccessThresholdOutOfRange.selector);
        cfg.setSuccessThresholdBps(10_001);
    }

    function test_setSuccessThresholdBps_max() public {
        vm.prank(admin);
        cfg.setSuccessThresholdBps(10_000);
        assertEq(cfg.successThresholdBps(), 10_000);
    }

    function test_setSuccessThresholdBps_min() public {
        vm.prank(admin);
        cfg.setSuccessThresholdBps(1);
        assertEq(cfg.successThresholdBps(), 1);
    }

    function test_setSuccessThresholdBps_unauthorized() public {
        vm.prank(alice);
        vm.expectRevert();
        cfg.setSuccessThresholdBps(500);
    }

    // ── setVoteWindow ─────────────────────────────────────────────────────────
    function test_setVoteWindow_success() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.VoteWindowUpdated(24 hours, 48 hours);
        cfg.setVoteWindow(48 hours);
        assertEq(cfg.voteWindow(), 48 hours);
    }

    function test_setVoteWindow_min() public {
        vm.prank(admin);
        cfg.setVoteWindow(1 hours);
    }

    function test_setVoteWindow_max() public {
        vm.prank(admin);
        cfg.setVoteWindow(14 days);
    }

    function test_setVoteWindow_tooShort_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.VoteWindowOutOfRange.selector);
        cfg.setVoteWindow(1 hours - 1);
    }

    function test_setVoteWindow_tooLong_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.VoteWindowOutOfRange.selector);
        cfg.setVoteWindow(14 days + 1);
    }

    // ── setQuorumBps ─────────────────────────────────────────────────────────
    function test_setQuorumBps() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.QuorumBpsUpdated(5000, 6000);
        cfg.setQuorumBps(6000);
        assertEq(cfg.quorumBps(), 6000);
    }

    function test_setQuorumBps_zero_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.QuorumOutOfRange.selector);
        cfg.setQuorumBps(0);
    }

    function test_setQuorumBps_above10000_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.QuorumOutOfRange.selector);
        cfg.setQuorumBps(10_001);
    }

    function test_setQuorumBps_min() public {
        vm.prank(admin);
        cfg.setQuorumBps(1);
        assertEq(cfg.quorumBps(), 1);
    }

    function test_setQuorumBps_max() public {
        vm.prank(admin);
        cfg.setQuorumBps(10_000);
        assertEq(cfg.quorumBps(), 10_000);
    }

    // ── setApprovalBps ────────────────────────────────────────────────────────
    function test_setApprovalBps() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.ApprovalBpsUpdated(5100, 6000);
        cfg.setApprovalBps(6000);
        assertEq(cfg.approvalBps(), 6000);
    }

    function test_setApprovalBps_tooLow_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.ApprovalTooLow.selector);
        cfg.setApprovalBps(5000);
    }

    function test_setApprovalBps_above10000_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.ApprovalTooLow.selector);
        cfg.setApprovalBps(10_001);
    }

    function test_setApprovalBps_min() public {
        vm.prank(admin);
        cfg.setApprovalBps(5001);
        assertEq(cfg.approvalBps(), 5001);
    }

    function test_setApprovalBps_max() public {
        vm.prank(admin);
        cfg.setApprovalBps(10_000);
        assertEq(cfg.approvalBps(), 10_000);
    }

    // ── setRefundSweepDelay ───────────────────────────────────────────────────
    function test_setRefundSweepDelay() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.RefundSweepDelayUpdated(180 days, 90 days);
        cfg.setRefundSweepDelay(90 days);
        assertEq(cfg.refundSweepDelay(), 90 days);
    }

    function test_setRefundSweepDelay_tooShort_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.RefundSweepDelayOutOfRange.selector);
        cfg.setRefundSweepDelay(30 days - 1);
    }

    function test_setRefundSweepDelay_tooLong_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.RefundSweepDelayOutOfRange.selector);
        cfg.setRefundSweepDelay(365 days + 1);
    }

    function test_setRefundSweepDelay_min() public {
        vm.prank(admin);
        cfg.setRefundSweepDelay(30 days);
        assertEq(cfg.refundSweepDelay(), 30 days);
    }

    function test_setRefundSweepDelay_max() public {
        vm.prank(admin);
        cfg.setRefundSweepDelay(365 days);
        assertEq(cfg.refundSweepDelay(), 365 days);
    }

    // ── setMinDonation ────────────────────────────────────────────────────────
    function test_setMinDonation() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit PlatformConfig.MinDonationUpdated(1e6, 5e6);
        cfg.setMinDonation(5e6);
        assertEq(cfg.minDonation(), 5e6);
    }

    function test_setMinDonation_zero_reverts() public {
        vm.prank(admin);
        vm.expectRevert(PlatformConfig.MinDonationZero.selector);
        cfg.setMinDonation(0);
    }

    // ── Roles ─────────────────────────────────────────────────────────────────
    function test_roles_operator() public view {
        assertTrue(cfg.hasRole(cfg.OPERATOR_ROLE(), operator));
        assertFalse(cfg.hasRole(cfg.OPERATOR_ROLE(), alice));
    }

    function test_roles_guardian() public view {
        assertTrue(cfg.hasRole(cfg.GUARDIAN_ROLE(), guardian));
    }
}
