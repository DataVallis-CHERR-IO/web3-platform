// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {EmergencyPool} from "../src/EmergencyPool.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Simulates the deploy script on Anvil and asserts role layout + contract linking.
contract DeployTest is Test {
    MockUSDC usdc;
    PlatformConfig platformConfig;
    CampaignFactory campaignFactory;
    Campaign campaignImpl;
    EmergencyPool emergencyPool;
    TimelockController timelock;

    address deployer = makeAddr("deployer");
    address safe = makeAddr("safe");
    address treasury = makeAddr("treasury");

    uint256 constant TIMELOCK_DELAY = 48 hours;

    function setUp() public {
        vm.startPrank(deployer);

        usdc = new MockUSDC();
        platformConfig = new PlatformConfig(address(usdc), deployer);
        campaignImpl = new Campaign();
        campaignFactory = new CampaignFactory(platformConfig, address(campaignImpl));
        emergencyPool = new EmergencyPool(platformConfig, campaignFactory);

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));

        platformConfig.setTreasury(treasury);
        platformConfig.setEmergencyPool(address(emergencyPool));
        platformConfig.grantRole(platformConfig.OPERATOR_ROLE(), safe);
        platformConfig.grantRole(platformConfig.GUARDIAN_ROLE(), safe);
        platformConfig.grantRole(platformConfig.DEFAULT_ADMIN_ROLE(), address(timelock));
        platformConfig.renounceRole(platformConfig.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopPrank();
    }

    // ── PlatformConfig roles ────────────────────────────────────────────────────

    function test_deployer_has_no_PlatformConfig_role() public view {
        assertFalse(platformConfig.hasRole(platformConfig.DEFAULT_ADMIN_ROLE(), deployer), "deployer has admin");
        assertFalse(platformConfig.hasRole(platformConfig.OPERATOR_ROLE(), deployer), "deployer has operator");
        assertFalse(platformConfig.hasRole(platformConfig.GUARDIAN_ROLE(), deployer), "deployer has guardian");
    }

    function test_timelock_has_DEFAULT_ADMIN() public view {
        assertTrue(
            platformConfig.hasRole(platformConfig.DEFAULT_ADMIN_ROLE(), address(timelock)), "timelock missing admin"
        );
    }

    function test_safe_has_OPERATOR() public view {
        assertTrue(platformConfig.hasRole(platformConfig.OPERATOR_ROLE(), safe), "safe missing operator");
    }

    function test_safe_has_GUARDIAN() public view {
        assertTrue(platformConfig.hasRole(platformConfig.GUARDIAN_ROLE(), safe), "safe missing guardian");
    }

    // ── Timelock roles ──────────────────────────────────────────────────────────

    function test_deployer_has_no_Timelock_role() public view {
        bytes32 adminRole = timelock.DEFAULT_ADMIN_ROLE();
        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();
        bytes32 cancellerRole = timelock.CANCELLER_ROLE();
        assertFalse(timelock.hasRole(adminRole, deployer), "deployer has timelock admin");
        assertFalse(timelock.hasRole(proposerRole, deployer), "deployer has proposer");
        assertFalse(timelock.hasRole(executorRole, deployer), "deployer has executor");
        assertFalse(timelock.hasRole(cancellerRole, deployer), "deployer has canceller");
    }

    function test_timelock_self_admin() public view {
        assertTrue(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(timelock)), "timelock not self-admin");
    }

    function test_safe_has_PROPOSER_and_EXECUTOR() public view {
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe), "safe missing proposer");
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), safe), "safe missing executor");
        // OZ also grants CANCELLER to proposers
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe), "safe missing canceller");
    }

    // ── Contract linking ────────────────────────────────────────────────────────

    function test_factory_linked_to_config() public view {
        assertEq(address(campaignFactory.config()), address(platformConfig));
    }

    function test_factory_linked_to_impl() public view {
        assertEq(campaignFactory.campaignImplementation(), address(campaignImpl));
    }

    function test_pool_linked_to_config() public view {
        assertEq(address(emergencyPool.config()), address(platformConfig));
    }

    function test_pool_linked_to_factory() public view {
        assertEq(address(emergencyPool.factory()), address(campaignFactory));
    }

    function test_config_emergencyPool_set() public view {
        assertEq(platformConfig.emergencyPool(), address(emergencyPool));
    }

    function test_config_treasury_set() public view {
        assertEq(platformConfig.treasury(), treasury);
    }

    function test_config_usdc_set() public view {
        assertEq(platformConfig.usdc(), address(usdc));
    }
}
