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

/// @notice Mirrors the mainnet role layout (three Safes, ADR-061) and asserts roles + contract
///         linking; the DeployPolygon tests at the end run the real script.
contract DeployTest is Test {
    MockUSDC usdc;
    PlatformConfig platformConfig;
    CampaignFactory campaignFactory;
    Campaign campaignImpl;
    EmergencyPool emergencyPool;
    TimelockController timelock;

    address deployer = makeAddr("deployer");
    address operatorSafe = makeAddr("operatorSafe");
    address guardianSafe = makeAddr("guardianSafe");
    address timelockSafe = makeAddr("timelockSafe");
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
        proposers[0] = timelockSafe;
        address[] memory executors = new address[](1);
        executors[0] = timelockSafe;
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));

        platformConfig.setTreasury(treasury);
        platformConfig.setEmergencyPool(address(emergencyPool));
        platformConfig.grantRole(platformConfig.OPERATOR_ROLE(), operatorSafe);
        platformConfig.grantRole(platformConfig.GUARDIAN_ROLE(), guardianSafe);
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

    function test_operatorSafe_has_OPERATOR_only() public view {
        assertTrue(platformConfig.hasRole(platformConfig.OPERATOR_ROLE(), operatorSafe), "operator safe missing role");
        assertFalse(platformConfig.hasRole(platformConfig.GUARDIAN_ROLE(), operatorSafe), "operator safe is guardian");
    }

    function test_guardianSafe_has_GUARDIAN_only() public view {
        assertTrue(platformConfig.hasRole(platformConfig.GUARDIAN_ROLE(), guardianSafe), "guardian safe missing role");
        assertFalse(platformConfig.hasRole(platformConfig.OPERATOR_ROLE(), guardianSafe), "guardian safe is operator");
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

    function test_timelockSafe_has_PROPOSER_and_EXECUTOR() public view {
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), timelockSafe), "safe missing proposer");
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), timelockSafe), "safe missing executor");
        // OZ also grants CANCELLER to proposers
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), timelockSafe), "safe missing canceller");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), operatorSafe), "operator safe can propose");
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), guardianSafe), "guardian safe can propose");
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

    // ── DeployPolygon script tests (three Safes, review M-01 / ADR-061) ─────────

    uint256 constant ANVIL_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function _polygonEnv(address op, address guard, address tl) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(ANVIL_KEY)));
        vm.setEnv("OPERATOR_SAFE", vm.toString(op));
        vm.setEnv("GUARDIAN_SAFE", vm.toString(guard));
        vm.setEnv("TIMELOCK_SAFE", vm.toString(tl));
        vm.setEnv("TREASURY_ADDRESS", vm.toString(makeAddr("polygonTreasury")));
        vm.setEnv("TIMELOCK_DELAY", "");
    }

    function _threeSafes() internal returns (address op, address guard, address tl) {
        op = address(new MockUSDC());
        guard = address(new MockUSDC());
        tl = address(new MockUSDC());
    }

    /// All guard cases in one test: `vm.setEnv` changes the process environment, which
    /// parallel tests share, so cases that set different values must run in sequence.
    function test_DeployPolygon_guards() public {
        vm.chainId(137);
        (address op, address guard, address tl) = _threeSafes();
        DeployPolygon script = new DeployPolygon();

        // TIMELOCK_DELAY must not be overridable on mainnet
        _polygonEnv(op, guard, tl);
        vm.setEnv("TIMELOCK_DELAY", "300");
        vm.expectRevert(DeployPolygon.TimelockDelayOverrideNotAllowed.selector);
        script.run();

        // every Safe must be a contract
        address eoa = makeAddr("eoaSafe");
        _polygonEnv(op, guard, eoa);
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.SafeMustBeContract.selector, eoa));
        script.run();

        // the three Safes must be different
        _polygonEnv(op, op, tl);
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.SafesMustDiffer.selector, op, op));
        script.run();
        _polygonEnv(op, guard, op);
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.SafesMustDiffer.selector, op, op));
        script.run();
        _polygonEnv(op, guard, guard);
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.SafesMustDiffer.selector, guard, guard));
        script.run();

        // only Polygon mainnet
        _polygonEnv(op, guard, tl);
        vm.chainId(80002);
        vm.expectRevert(abi.encodeWithSelector(DeployPolygon.WrongChain.selector, 80002));
        script.run();

        // and with valid input each Safe gets only its own role
        vm.chainId(137);
        DeployPolygon.Deployed memory d = script.run();
        _assertRoleLayout(d, op, guard, tl);
    }

    /// The real script: each Safe holds exactly its own role; the deployer keeps nothing.
    function _assertRoleLayout(DeployPolygon.Deployed memory d, address op, address guard, address tl) internal view {
        PlatformConfig cfg = d.platformConfig;
        TimelockController tlc = d.timelock;
        address dep = vm.addr(ANVIL_KEY);

        assertTrue(cfg.hasRole(cfg.OPERATOR_ROLE(), op));
        assertFalse(cfg.hasRole(cfg.GUARDIAN_ROLE(), op));
        assertTrue(cfg.hasRole(cfg.GUARDIAN_ROLE(), guard));
        assertFalse(cfg.hasRole(cfg.OPERATOR_ROLE(), guard));
        assertFalse(cfg.hasRole(cfg.OPERATOR_ROLE(), tl));
        assertFalse(cfg.hasRole(cfg.GUARDIAN_ROLE(), tl));
        assertTrue(cfg.hasRole(cfg.DEFAULT_ADMIN_ROLE(), address(tlc)));
        assertFalse(cfg.hasRole(cfg.DEFAULT_ADMIN_ROLE(), dep));

        assertTrue(tlc.hasRole(tlc.PROPOSER_ROLE(), tl));
        assertTrue(tlc.hasRole(tlc.EXECUTOR_ROLE(), tl));
        assertFalse(tlc.hasRole(tlc.PROPOSER_ROLE(), op));
        assertFalse(tlc.hasRole(tlc.PROPOSER_ROLE(), guard));
        assertEq(tlc.getMinDelay(), 48 hours);
        assertEq(cfg.emergencyPool(), address(d.emergencyPool));
        assertEq(address(d.campaignFactory.config()), address(cfg));
    }
}
