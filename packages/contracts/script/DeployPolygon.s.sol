// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {EmergencyPool} from "../src/EmergencyPool.sol";

/// @notice Deployment script for Polygon mainnet.
///         Env: DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, TREASURY_ADDRESS.
///         Usage: forge script script/DeployPolygon.s.sol --rpc-url $ALCHEMY_POLYGON_URL --broadcast --verify
///         DO NOT run without David's explicit go-ahead.
contract DeployPolygon is Script {
    // Native Circle USDC on Polygon mainnet (NOT USDC.e bridged)
    address constant POLYGON_USDC = 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    uint256 constant TIMELOCK_DELAY = 48 hours;

    error WrongChain(uint256 actual);

    function run() external {
        if (block.chainid != 137) revert WrongChain(block.chainid);

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address safe = vm.envAddress("SAFE_ADDRESS");
        address treasury = vm.envAddress("TREASURY_ADDRESS");
        string memory commitSha = vm.envOr("COMMIT_SHA", string(""));

        vm.startBroadcast(deployerKey);

        PlatformConfig platformConfig = new PlatformConfig(POLYGON_USDC, deployer);
        console2.log("PlatformConfig   :", address(platformConfig));

        Campaign campaignImpl = new Campaign();
        console2.log("CampaignImpl     :", address(campaignImpl));

        CampaignFactory campaignFactory = new CampaignFactory(platformConfig, address(campaignImpl));
        console2.log("CampaignFactory  :", address(campaignFactory));

        EmergencyPool emergencyPool = new EmergencyPool(platformConfig, campaignFactory);
        console2.log("EmergencyPool    :", address(emergencyPool));

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = safe;
        TimelockController timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
        console2.log("Timelock         :", address(timelock));

        platformConfig.setTreasury(treasury);
        platformConfig.setEmergencyPool(address(emergencyPool));
        platformConfig.grantRole(platformConfig.OPERATOR_ROLE(), safe);
        platformConfig.grantRole(platformConfig.GUARDIAN_ROLE(), safe);
        platformConfig.grantRole(platformConfig.DEFAULT_ADMIN_ROLE(), address(timelock));
        platformConfig.renounceRole(platformConfig.DEFAULT_ADMIN_ROLE(), deployer);

        vm.stopBroadcast();

        _writeDeployJson(
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
        vm.serializeUint(obj, "chainId", uint256(137));
        vm.serializeString(obj, "deployedAt", vm.toString(block.timestamp));
        vm.serializeString(obj, "commitSha", commitSha);
        vm.serializeAddress(obj, "deployer", deployer);
        string memory json = vm.serializeString(obj, "contracts", contractsJson);

        vm.writeFile("deployments/polygon.json", json);
        console2.log("Wrote: deployments/polygon.json");
    }
}
