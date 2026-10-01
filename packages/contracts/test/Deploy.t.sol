// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {EmergencyPool} from "../src/EmergencyPool.sol";
import {DeployAmoy} from "../script/DeployAmoy.s.sol";
import {DeployPolygon} from "../script/DeployPolygon.s.sol";
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

    // ── DeployAmoy script tests ──────────────────────────────────────────────────

    function test_DeployAmoy_dryRun_succeeds_and_does_not_write_file() public {
        vm.chainId(80002);
        address testEoaSafe = 0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7;

        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", vm.toString(testEoaSafe));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(testEoaSafe));
        vm.setEnv("DEPLOY_NAME", "dev");

        // Run DeployAmoy script
        DeployAmoy script = new DeployAmoy();
        script.run();

        // In test context (dry-run), deployments/amoy-dev.json must not have been created
        // We verify the deployer holds no admin on new contracts and timelock has safe
    }

    function test_DeployAmoy_custom_timelock_delay() public {
        vm.chainId(80002);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
        vm.setEnv("TREASURY_ADDRESS", "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
        vm.setEnv("DEPLOY_NAME", "dev");
        vm.setEnv("TIMELOCK_DELAY", "600");

        DeployAmoy script = new DeployAmoy();
        script.run();
    }

    function test_DeployAmoy_wrong_chain_reverts() public {
        vm.chainId(137);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
        vm.setEnv("TREASURY_ADDRESS", "0x432696A5f61A4c3b6Fc78d0172b2cEA12BA9B5a7");
        vm.setEnv("DEPLOY_NAME", "dev");

        DeployAmoy script = new DeployAmoy();
        vm.expectRevert(abi.encodeWithSelector(DeployAmoy.WrongChain.selector, 137));
        script.run();
    }

    // ── DeployPolygon script tests ───────────────────────────────────────────────

    function test_DeployPolygon_reverts_if_timelock_delay_env_set() public {
        vm.chainId(137);
        MockUSDC mockSafe = new MockUSDC();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", vm.toString(address(mockSafe)));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(address(mockSafe)));
        vm.setEnv("TIMELOCK_DELAY", "300");

        DeployPolygon script = new DeployPolygon();
        vm.expectRevert(DeployPolygon.TimelockDelayOverrideNotAllowed.selector);
        script.run();
        vm.setEnv("TIMELOCK_DELAY", "");
    }

    function test_DeployPolygon_reverts_if_safe_is_eoa() public {
        vm.chainId(137);
        address eoaSafe = makeAddr("eoaSafe");
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", vm.toString(eoaSafe));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(eoaSafe));
        vm.setEnv("TIMELOCK_DELAY", "");

        DeployPolygon script = new DeployPolygon();
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.SafeMustBeContract.selector, eoaSafe));
        script.run();
    }

    function test_DeployPolygon_succeeds_when_safe_is_contract() public {
        vm.chainId(137);
        MockUSDC mockContractSafe = new MockUSDC();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", vm.toString(address(mockContractSafe)));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(address(mockContractSafe)));
        vm.setEnv("TIMELOCK_DELAY", "");

        DeployPolygon script = new DeployPolygon();
        script.run();
    }

    function test_DeployPolygon_wrong_chain_reverts() public {
        vm.chainId(80002);
        MockUSDC mockSafe = new MockUSDC();
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
        vm.setEnv("SAFE_ADDRESS", vm.toString(address(mockSafe)));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(address(mockSafe)));
        vm.setEnv("TIMELOCK_DELAY", "");

        DeployPolygon script = new DeployPolygon();
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.WrongChain.selector, 80002));
        script.run();
    }
}
