// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PlatformConfig} from "./PlatformConfig.sol";
import {Campaign} from "./Campaign.sol";

/// @title CampaignFactory
/// @notice Deploys EIP-1167 deterministic Campaign clones. Only OPERATOR_ROLE may create
///         campaigns. The clone address is predictable before deployment via
///         predictCampaignAddress(offchainId).
contract CampaignFactory {
    using Clones for address;

    // ── Types ─────────────────────────────────────────────────────────────────
    struct CreateParams {
        bytes32 offchainId;
        address beneficiary;
        uint256 target;
        uint64 deadline;
        uint8 beneficiaryType; // 0 = ORG, 1 = INDIVIDUAL
    }

    // ── Constants ─────────────────────────────────────────────────────────────
    uint256 private constant MIN_TARGET = 100e6; // 100 USDC (6 dec)
    uint64 private constant MIN_DEADLINE_OFFSET = 1 days;
    uint64 private constant MAX_DEADLINE_OFFSET = 90 days;

    // ── Immutable ─────────────────────────────────────────────────────────────
    PlatformConfig public immutable config;
    address public immutable campaignImplementation;

    // ── State ─────────────────────────────────────────────────────────────────
    mapping(bytes32 => address) public campaigns; // offchainId → clone address
    mapping(address => bool) private _isCampaign;

    // ── Events ────────────────────────────────────────────────────────────────
    event CampaignCreated(
        address indexed campaign,
        bytes32 indexed offchainId,
        address indexed beneficiary,
        uint256 target,
        uint64 deadline,
        uint8 beneficiaryType
    );

    // ── Errors ────────────────────────────────────────────────────────────────
    error Unauthorized();
    error ZeroAddress();
    error InvalidBeneficiary();
    error InvalidBeneficiaryType();
    error TargetTooLow();
    error DeadlineOutOfRange();
    error DuplicateOffchainId();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(PlatformConfig _config, address _campaignImpl) {
        if (address(_config) == address(0) || _campaignImpl == address(0)) revert ZeroAddress();
        config = _config;
        campaignImplementation = _campaignImpl;
    }

    // ── External ──────────────────────────────────────────────────────────────

    /// @notice Deploys a new Campaign clone deterministically keyed by offchainId.
    ///         Only OPERATOR_ROLE may call.
    function createCampaign(CreateParams calldata p) external returns (address campaign) {
        if (!config.hasRole(config.OPERATOR_ROLE(), msg.sender)) revert Unauthorized();
        if (p.beneficiary == address(0)) revert InvalidBeneficiary();
        if (p.beneficiaryType > 1) revert InvalidBeneficiaryType();
        if (p.target < MIN_TARGET) revert TargetTooLow();

        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 now_ = uint64(block.timestamp);
        if (p.deadline < now_ + MIN_DEADLINE_OFFSET || p.deadline > now_ + MAX_DEADLINE_OFFSET) {
            revert DeadlineOutOfRange();
        }
        if (campaigns[p.offchainId] != address(0)) revert DuplicateOffchainId();

        campaign = campaignImplementation.cloneDeterministic(p.offchainId);
        campaigns[p.offchainId] = campaign;
        _isCampaign[campaign] = true;

        // Emit before external call (CEI pattern); initialize is our own contract and
        // is replay-protected by Initializable, so event ordering is safe.
        emit CampaignCreated(campaign, p.offchainId, p.beneficiary, p.target, p.deadline, p.beneficiaryType);

        Campaign(campaign).initialize(config, p.offchainId, p.beneficiary, p.target, p.deadline, p.beneficiaryType);
    }

    /// @notice Predict the deterministic address a campaign will be deployed to.
    function predictCampaignAddress(bytes32 offchainId) external view returns (address) {
        return Clones.predictDeterministicAddress(campaignImplementation, offchainId, address(this));
    }

    /// @notice Returns true if addr is a Campaign clone created by this factory.
    function isCampaign(address addr) external view returns (bool) {
        return _isCampaign[addr];
    }
}
