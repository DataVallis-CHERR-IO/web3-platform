// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
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
    address pool = makeAddr("inv-pool");
    address beneficiary = makeAddr("inv-beneficiary");

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        factory = new CampaignFactory(cfg, address(new Campaign()));

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(pool);
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

        handler = new CampaignHandler(campaign, usdc, cfg, operator, pool);

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = CampaignHandler.handler_donate.selector;
        selectors[1] = CampaignHandler.handler_finalize.selector;
        selectors[2] = CampaignHandler.handler_setPayoutMode.selector;
        selectors[3] = CampaignHandler.handler_release.selector;
        selectors[4] = CampaignHandler.handler_claimRefund.selector;
        selectors[5] = CampaignHandler.handler_settleToPool.selector;
        selectors[6] = CampaignHandler.handler_sweepUnclaimed.selector;
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
}
