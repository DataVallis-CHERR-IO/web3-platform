// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Local Anvil deployment only.
///         Amoy deployment will be a separate script added in TASK-004.
///         Usage: forge script script/DeployCore.s.sol --rpc-url http://localhost:8545 --broadcast
contract DeployCore is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        // Local only: deploy a mock USDC for Anvil
        MockUSDC usdc = new MockUSDC();
        console2.log("MockUSDC         :", address(usdc));

        // Platform config — deployer is DEFAULT_ADMIN_ROLE for local dev
        PlatformConfig platformConfig = new PlatformConfig(address(usdc), deployer);
        console2.log("PlatformConfig   :", address(platformConfig));

        // Campaign implementation (constructor calls _disableInitializers)
        Campaign campaignImpl = new Campaign();
        console2.log("CampaignImpl     :", address(campaignImpl));

        // Factory
        CampaignFactory campaignFactory = new CampaignFactory(platformConfig, address(campaignImpl));
        console2.log("CampaignFactory  :", address(campaignFactory));

        // Bootstrap roles — deployer acts as operator and holds treasury for local testing
        platformConfig.grantRole(platformConfig.OPERATOR_ROLE(), deployer);
        platformConfig.setTreasury(deployer);
        // emergencyPool intentionally left unset; configure with setEmergencyPool() after TASK-004

        vm.stopBroadcast();
    }
}
