// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract CampaignFactoryTest is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    MockUSDC usdc;
    Campaign impl;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address beneficiary = makeAddr("beneficiary");

    CampaignFactory.CreateParams baseParams;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        impl = new Campaign();
        factory = new CampaignFactory(cfg, address(impl));

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.setTreasury(makeAddr("treasury"));
        vm.stopPrank();

        baseParams = CampaignFactory.CreateParams({
            offchainId: keccak256("campaign-1"),
            beneficiary: beneficiary,
            target: 1000e6,
            deadline: uint64(block.timestamp + 30 days),
            beneficiaryType: 0
        });
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    function test_constructor_zeroConfig_reverts() public {
        vm.expectRevert(CampaignFactory.ZeroAddress.selector);
        new CampaignFactory(PlatformConfig(address(0)), address(impl));
    }

    function test_constructor_zeroImpl_reverts() public {
        vm.expectRevert(CampaignFactory.ZeroAddress.selector);
        new CampaignFactory(cfg, address(0));
    }

    // ── createCampaign ────────────────────────────────────────────────────────
    function test_createCampaign_success() public {
        address predicted = factory.predictCampaignAddress(baseParams.offchainId);

        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit CampaignFactory.CampaignCreated(
            predicted,
            baseParams.offchainId,
            beneficiary,
            baseParams.target,
            baseParams.deadline,
            baseParams.beneficiaryType
        );
        address campaign = factory.createCampaign(baseParams);

        assertEq(campaign, predicted);
        assertTrue(factory.isCampaign(campaign));
        assertEq(factory.campaigns(baseParams.offchainId), campaign);

        Campaign c = Campaign(campaign);
        assertEq(c.beneficiary(), beneficiary);
        assertEq(c.target(), baseParams.target);
        assertEq(c.deadline(), baseParams.deadline);
        assertEq(uint8(c.state()), 0); // LIVE
    }

    function test_createCampaign_unauthorized_reverts() public {
        vm.prank(alice);
        vm.expectRevert(CampaignFactory.Unauthorized.selector);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_zeroBeneficiary_reverts() public {
        baseParams.beneficiary = address(0);
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.InvalidBeneficiary.selector);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_targetTooLow_reverts() public {
        baseParams.target = 99e6; // < 100 USDC
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.TargetTooLow.selector);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_exactMinTarget_succeeds() public {
        baseParams.target = 100e6;
        vm.prank(operator);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_deadlineTooEarly_reverts() public {
        baseParams.deadline = uint64(block.timestamp + 1 days - 1);
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.DeadlineOutOfRange.selector);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_deadlineTooLate_reverts() public {
        baseParams.deadline = uint64(block.timestamp + 90 days + 1);
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.DeadlineOutOfRange.selector);
        factory.createCampaign(baseParams);
    }

    function test_createCampaign_deadlineEdges_succeed() public {
        CampaignFactory.CreateParams memory p = baseParams;
        p.offchainId = keccak256("min-dl");
        p.deadline = uint64(block.timestamp + 1 days);
        vm.prank(operator);
        factory.createCampaign(p);

        p.offchainId = keccak256("max-dl");
        p.deadline = uint64(block.timestamp + 90 days);
        vm.prank(operator);
        factory.createCampaign(p);
    }

    function test_createCampaign_duplicateId_reverts() public {
        vm.prank(operator);
        factory.createCampaign(baseParams);

        baseParams.deadline = uint64(block.timestamp + 31 days); // different params, same id
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.DuplicateOffchainId.selector);
        factory.createCampaign(baseParams);
    }

    // ── predictCampaignAddress ────────────────────────────────────────────────
    function test_predictCampaignAddress_matchesDeployed() public {
        address predicted = factory.predictCampaignAddress(baseParams.offchainId);
        vm.prank(operator);
        address deployed = factory.createCampaign(baseParams);
        assertEq(predicted, deployed);
    }

    // ── isCampaign ────────────────────────────────────────────────────────────
    function test_isCampaign_falseForRandom() public view {
        assertFalse(factory.isCampaign(alice));
    }

    // ── InvalidBeneficiaryType ──────────────────────────────────────────────
    function test_createCampaign_invalidBeneficiaryType_reverts() public {
        baseParams.beneficiaryType = 2;
        vm.prank(operator);
        vm.expectRevert(CampaignFactory.InvalidBeneficiaryType.selector);
        factory.createCampaign(baseParams);
    }

    // ── Snapshot isolation ────────────────────────────────────────────────────
    function test_snapshotIsolation_feeDoesNotChange() public {
        vm.prank(operator);
        address campaign = factory.createCampaign(baseParams);
        assertEq(Campaign(campaign).snapFeeBps(), 100);

        // Admin changes fee after campaign is created
        vm.prank(admin);
        cfg.setFeeBps(300);

        // Campaign still uses snapshotted value
        assertEq(Campaign(campaign).snapFeeBps(), 100);
        assertEq(cfg.feeBps(), 300);
    }
}
