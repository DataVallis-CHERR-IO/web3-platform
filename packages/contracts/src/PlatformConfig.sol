// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title PlatformConfig
/// @notice Singleton holding all platform-wide parameters and roles.
///         All configuration changes must come through the 48h TimelockController
///         (DEFAULT_ADMIN_ROLE holder) except Guardian actions which are direct.
contract PlatformConfig is AccessControl {
    // ── Roles ────────────────────────────────────────────────────────────────
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ── Constants ─────────────────────────────────────────────────────────────
    uint16 public constant MAX_FEE_BPS = 500;
    uint32 public constant MIN_VOTE_WINDOW = 1 hours;
    uint32 public constant MAX_VOTE_WINDOW = 14 days;
    uint32 public constant MAX_RELEASE_DELAY = 7 days;

    // ── Immutable ─────────────────────────────────────────────────────────────
    address public immutable usdc;

    // ── Mutable state ─────────────────────────────────────────────────────────
    address public treasury;
    address public emergencyPool;
    uint16 public feeBps = 100;
    uint16 public successThresholdBps = 1000;
    uint32 public voteWindow = 24 hours;
    uint16 public quorumBps = 5000;
    uint16 public approvalBps = 5100;
    uint32 public refundSweepDelay = 180 days;
    uint256 public minDonation = 1e6;
    uint32 public releaseDelay = 72 hours;

    // ── Events ────────────────────────────────────────────────────────────────
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event EmergencyPoolUpdated(address indexed oldPool, address indexed newPool);
    event FeeBpsUpdated(uint16 oldBps, uint16 newBps);
    event SuccessThresholdBpsUpdated(uint16 oldBps, uint16 newBps);
    event VoteWindowUpdated(uint32 oldWindow, uint32 newWindow);
    event QuorumBpsUpdated(uint16 oldBps, uint16 newBps);
    event ApprovalBpsUpdated(uint16 oldBps, uint16 newBps);
    event RefundSweepDelayUpdated(uint32 oldDelay, uint32 newDelay);
    event MinDonationUpdated(uint256 oldMin, uint256 newMin);
    event ReleaseDelayUpdated(uint32 oldDelay, uint32 newDelay);

    // ── Errors ────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error FeeTooHigh();
    error VoteWindowOutOfRange();
    error SuccessThresholdOutOfRange();
    error QuorumOutOfRange();
    error ApprovalTooLow();
    error RefundSweepDelayOutOfRange();
    error MinDonationZero();
    error ReleaseDelayOutOfRange();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _usdc, address _admin) {
        if (_usdc == address(0) || _admin == address(0)) revert ZeroAddress();
        usdc = _usdc;
        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
    }

    // ── Setters ───────────────────────────────────────────────────────────────
    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice emergencyPool is updatable (non-zero only); protected by 48h timelock.
    function setEmergencyPool(address _emergencyPool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_emergencyPool == address(0)) revert ZeroAddress();
        emit EmergencyPoolUpdated(emergencyPool, _emergencyPool);
        emergencyPool = _emergencyPool;
    }

    function setFeeBps(uint16 _feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        emit FeeBpsUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setSuccessThresholdBps(uint16 _bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_bps == 0 || _bps > 10_000) revert SuccessThresholdOutOfRange();
        emit SuccessThresholdBpsUpdated(successThresholdBps, _bps);
        successThresholdBps = _bps;
    }

    function setVoteWindow(uint32 _voteWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_voteWindow < MIN_VOTE_WINDOW || _voteWindow > MAX_VOTE_WINDOW) revert VoteWindowOutOfRange();
        emit VoteWindowUpdated(voteWindow, _voteWindow);
        voteWindow = _voteWindow;
    }

    function setQuorumBps(uint16 _quorumBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_quorumBps == 0 || _quorumBps > 10_000) revert QuorumOutOfRange();
        emit QuorumBpsUpdated(quorumBps, _quorumBps);
        quorumBps = _quorumBps;
    }

    function setApprovalBps(uint16 _approvalBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_approvalBps < 5001 || _approvalBps > 10_000) revert ApprovalTooLow();
        emit ApprovalBpsUpdated(approvalBps, _approvalBps);
        approvalBps = _approvalBps;
    }

    function setRefundSweepDelay(uint32 _delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_delay < 30 days || _delay > 365 days) revert RefundSweepDelayOutOfRange();
        emit RefundSweepDelayUpdated(refundSweepDelay, _delay);
        refundSweepDelay = _delay;
    }

    function setMinDonation(uint256 _minDonation) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_minDonation == 0) revert MinDonationZero();
        emit MinDonationUpdated(minDonation, _minDonation);
        minDonation = _minDonation;
    }

    function setReleaseDelay(uint32 _delay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_delay > MAX_RELEASE_DELAY) revert ReleaseDelayOutOfRange();
        emit ReleaseDelayUpdated(releaseDelay, _delay);
        releaseDelay = _delay;
    }
}
