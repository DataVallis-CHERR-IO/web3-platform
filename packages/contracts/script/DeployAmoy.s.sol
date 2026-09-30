// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {EmergencyPool} from "../src/EmergencyPool.sol";

/// @notice Deployment script for Polygon Amoy testnet.
///         Env: DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, TREASURY_ADDRESS, DEPLOY_NAME (dev|uat).
///         Usage: forge script script/DeployAmoy.s.sol --rpc-url $ALCHEMY_AMOY_URL --broadcast --verify
///         DO NOT run without David's explicit go-ahead.
contract DeployAmoy is Script {
    // Circle USDC on Polygon Amoy
    address constant AMOY_USDC = 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582;
    uint256 constant TIMELOCK_DELAY = 48 hours;

    error WrongChain(uint256 actual);

    function run() external {
        if (block.chainid != 80002) revert WrongChain(block.chainid);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address safe = vm.envAddress("SAFE_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        string memory deployName = vm.envString("DEPLOY_NAME");
        string memory commitSha = vm.envOr("COMMIT_SHA", string(""));

        vm.startBroadcast(deployerKey);

        // 1. PlatformConfig — deployer is temporary admin
        PlatformConfig platformConfig = new PlatformConfig(AMOY_USDC, deployer);
        console2.log("PlatformConfig   :", address(platformConfig));

        // 2. Campaign implementation
        Campaign campaignImpl = new Campaign();
        console2.log("CampaignImpl     :", address(campaignImpl));

        // 3. Factory
        CampaignFactory campaignFactory = new CampaignFactory(platformConfig, address(campaignImpl));
        console2.log("CampaignFactory  :", address(campaignFactory));

        // 4. EmergencyPool
        EmergencyPool emergencyPool = new EmergencyPool(platformConfig, campaignFactory);
        console2.log("EmergencyPool    :", address(emergencyPool));

        // 5. TimelockController — Safe as proposer+executor, no admin
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        TimelockController timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
        console2.log("Timelock         :", address(timelock));

        // 6. Configure platform
        platformConfig.setTreasury(treasury);
        platformConfig.setEmergencyPool(address(emergencyPool));

        // 7. Grant roles
        platformConfig.grantRole(platformConfig.OPERATOR_ROLE(), safe);
        platformConfig.grantRole(platformConfig.GUARDIAN_ROLE(), safe);
        platformConfig.grantRole(platformConfig.DEFAULT_ADMIN_ROLE(), address(timelock));

        // 8. Renounce deployer's admin
        platformConfig.renounceRole(platformConfig.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        // Write deployment JSON
        _writeDeployJson(
            deployName,
            commitSha,
            deployer,
            address(platformConfig),
            address(campaignFactory),
            address(campaignImpl),
            address(emergencyPool),
            address(timelock)
        );
    }

    function _contractEntry(string memory key, address addr) internal returns (string memory) {
        vm.serializeAddress(key, "address", addr);
        return vm.serializeUint(key, "startBlock", block.number);
    }

    function _writeDeployJson(
        string memory deployName,
        string memory commitSha,
        address deployer,
        address platformConfig,
        address campaignFactory,
        address campaignImpl,
        address emergencyPool,
        address timelock
    ) internal {
        string memory contracts = "contracts";
        vm.serializeString(contracts, "platformConfig", _contractEntry("c1", platformConfig));
        vm.serializeString(contracts, "campaignFactory", _contractEntry("c2", campaignFactory));
        vm.serializeString(contracts, "campaignImplementation", _contractEntry("c3", campaignImpl));
        vm.serializeString(contracts, "emergencyPool", _contractEntry("c4", emergencyPool));
        string memory contractsJson =
            vm.serializeString(contracts, "timelockController", _contractEntry("c5", timelock));

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", uint256(80002));
        vm.serializeString(obj, "deployedAt", vm.toString(block.timestamp));
        vm.serializeString(obj, "commitSha", commitSha);
        vm.serializeAddress(obj, "deployer", deployer);
        string memory json = vm.serializeString(obj, "contracts", contractsJson);

        string memory path = string.concat("deployments/amoy-", deployName, ".json");
        vm.writeFile(path, json);
        console2.log("Wrote:", path);
    }
}
