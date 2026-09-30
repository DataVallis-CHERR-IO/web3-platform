// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlatformConfig} from "./PlatformConfig.sol";

/// @title Campaign
/// @notice Per-campaign USDC escrow deployed as an EIP-1167 clone by CampaignFactory.
///         Non-upgradeable; the constructor disables initializers on the implementation.
///         SINGLE payout implemented here. MILESTONES payout implemented in TASK-003.
///
/// Storage layout (packed):
///  slot 0 : config(20B) | state(1B) | payoutMode(1B) | payoutModeSet(1B) | beneficiaryType(1B)
///  slot 1 : offchainId(32B)
///  slot 2 : beneficiary(20B) | deadline(8B)
///  slot 3 : endTime(8B)
///  slot 4 : target
///  slot 5 : totalRaised
///  slot 6 : released  (beneficiary portion only)
///  slot 7 : feePaid
///  slot 8 : totalRefunded
///  slot 9 : totalSentToPool
///  slot 10: snapFeeBps(2B)|snapSuccessThresholdBps(2B)|snapRefundSweepDelay(4B)|snapVoteWindow(4B)|snapQuorumBps(2B)|snapApprovalBps(2B)
///  slot 11: swept(1B)
///  mappings: donated, preference, donorSubPoolId, settled
contract Campaign is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ─────────────────────────────────────────────────────────────────
    enum CampaignState {
        LIVE,
        SUCCEEDED,
        FAILED,
        PAYING,
        COMPLETED,
        VOTING,
        NEEDS_REVIEW,
        REJECTED,
        FROZEN
    }

    // ── Packed slot 0 ─────────────────────────────────────────────────────────
    PlatformConfig public config;
    CampaignState public state;
    uint8 public payoutMode; // 0 = SINGLE, 1 = MILESTONES
    bool public payoutModeSet;
    uint8 public beneficiaryType; // 0 = ORG, 1 = INDIVIDUAL

    // ── Slot 1 ────────────────────────────────────────────────────────────────
    bytes32 public offchainId;

    // ── Packed slot 2 ─────────────────────────────────────────────────────────
    address public beneficiary;
    uint64 public deadline;

    // ── Slot 3 ────────────────────────────────────────────────────────────────
    uint64 public endTime;

    // ── Slots 4-9 ─────────────────────────────────────────────────────────────
    uint256 public target;
    uint256 public totalRaised;
    uint256 public released; // beneficiary payouts only
    uint256 public feePaid;
    uint256 public totalRefunded;
    uint256 public totalSentToPool;

    // ── Packed slot 10 (snapshotted at initialize) ─────────────────────────────
    uint16 public snapFeeBps;
    uint16 public snapSuccessThresholdBps;
    uint32 public snapRefundSweepDelay;
    uint32 public snapVoteWindow;
    uint16 public snapQuorumBps;
    uint16 public snapApprovalBps;

    // ── Slot 11 ───────────────────────────────────────────────────────────────
    bool public swept;

    // ── Mappings ──────────────────────────────────────────────────────────────
    mapping(address => uint256) public donated;
    mapping(address => uint8) public preference; // 0 = REFUND, 1 = EMERGENCY_POOL
    mapping(address => uint32) public donorSubPoolId;
    mapping(address => bool) public settled; // set by claimRefund OR settleToPool

    // ── Events ────────────────────────────────────────────────────────────────
    event Donated(address indexed donor, uint256 amount, uint8 preference, uint32 subPoolId);
    event PreferenceSet(address indexed donor, uint8 preference, uint32 subPoolId);
    event Finalized(CampaignState indexed newState);
    event PayoutModeSet(uint8 mode);
    event TrancheReleased(address indexed beneficiary, uint256 amount, uint256 fee);
    event Refunded(address indexed donor, uint256 amount);
    event SentToPool(address indexed donor, uint256 amount, uint32 subPoolId);
    event Swept(uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotLive();
    error NotFailed();
    error NotSucceeded();
    error NotOperator();
    error PastDeadline();
    error DeadlineNotReached();
    error AmountTooLow();
    error InvalidPreference();
    error NotDonor();
    error AlreadySettled();
    error AlreadySwept();
    error SweepDelayNotReached();
    error PoolNotConfigured();
    error TreasuryNotSet();
    error IndividualCannotBeSingle();
    error PayoutModeNotSet();
    error PayoutModeAlreadySet();
    error InvalidPayoutMode();
    error NotImplemented();
    error ZeroAmount();
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────────────────────────
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ── Initializer ───────────────────────────────────────────────────────────
    function initialize(
        PlatformConfig _config,
        bytes32 _offchainId,
        address _beneficiary,
        uint256 _target,
        uint64 _deadline,
        uint8 _beneficiaryType
    ) external initializer {
        if (_beneficiary == address(0)) revert ZeroAddress();
        config = _config;
        offchainId = _offchainId;
        beneficiary = _beneficiary;
        target = _target;
        deadline = _deadline;
        beneficiaryType = _beneficiaryType;
        state = CampaignState.LIVE;
        // Snapshot live config values so running campaigns are immune to future changes
        snapFeeBps = _config.feeBps();
        snapSuccessThresholdBps = _config.successThresholdBps();
        snapRefundSweepDelay = _config.refundSweepDelay();
        snapVoteWindow = _config.voteWindow();
        snapQuorumBps = _config.quorumBps();
        snapApprovalBps = _config.approvalBps();
    }

    // ── Donations ─────────────────────────────────────────────────────────────

    /// @notice Donate USDC to this campaign.
    ///         Amount is clipped to the remaining target so the campaign succeeds in one tx.
    ///         Preference is updated on every donate; use setPreference() to change it later.
    function donate(uint256 amount, uint8 pref, uint32 subPoolId) external nonReentrant {
        if (state != CampaignState.LIVE) revert NotLive();
        if (block.timestamp >= deadline) revert PastDeadline();
        if (amount < config.minDonation()) revert AmountTooLow();
        if (pref > 1) revert InvalidPreference();

        // Clip to remaining so we never exceed target
        uint256 rem = target - totalRaised;
        uint256 clipped = amount > rem ? rem : amount;

        IERC20(config.usdc()).safeTransferFrom(msg.sender, address(this), clipped);

        donated[msg.sender] += clipped;
        totalRaised += clipped;
        preference[msg.sender] = pref;
        donorSubPoolId[msg.sender] = subPoolId;

        emit Donated(msg.sender, clipped, pref, subPoolId);

        if (totalRaised == target) {
            // forge-lint: disable-next-line(unsafe-typecast)
            endTime = uint64(block.timestamp);
            state = CampaignState.SUCCEEDED;
            emit Finalized(CampaignState.SUCCEEDED);
        }
    }

    /// @notice Change failure-preference while campaign is LIVE.
    ///         Only callable by existing donors.
    function setPreference(uint8 pref, uint32 subPoolId) external {
        if (state != CampaignState.LIVE) revert NotLive();
        if (donated[msg.sender] == 0) revert NotDonor();
        if (pref > 1) revert InvalidPreference();
        preference[msg.sender] = pref;
        donorSubPoolId[msg.sender] = subPoolId;
        emit PreferenceSet(msg.sender, pref, subPoolId);
    }

    // ── Finalization ──────────────────────────────────────────────────────────

    /// @notice Anyone may call after the deadline. Transitions to SUCCEEDED or FAILED.
    function finalize() external {
        if (state != CampaignState.LIVE) revert NotLive();
        if (block.timestamp < deadline) revert DeadlineNotReached();
        // forge-lint: disable-next-line(unsafe-typecast)
        endTime = uint64(block.timestamp);
        // success if raised >= successThreshold% of target
        if (totalRaised * 10_000 >= uint256(target) * snapSuccessThresholdBps) {
            state = CampaignState.SUCCEEDED;
            emit Finalized(CampaignState.SUCCEEDED);
        } else {
            state = CampaignState.FAILED;
            emit Finalized(CampaignState.FAILED);
        }
    }

    // ── Payout ────────────────────────────────────────────────────────────────

    /// @notice OPERATOR_ROLE sets the payout mode before any release.
    ///         INDIVIDUAL campaigns may never use SINGLE.
    function setPayoutMode(uint8 mode) external {
        if (!config.hasRole(config.OPERATOR_ROLE(), msg.sender)) revert NotOperator();
        if (state != CampaignState.SUCCEEDED) revert NotSucceeded();
        if (payoutModeSet) revert PayoutModeAlreadySet();
        if (mode > 1) revert InvalidPayoutMode();
        if (mode == 0 && beneficiaryType == 1) revert IndividualCannotBeSingle();
        payoutMode = mode;
        payoutModeSet = true;
        emit PayoutModeSet(mode);
    }

    /// @notice Execute payout. SINGLE: fee → treasury, rest → beneficiary, state → COMPLETED.
    ///         MILESTONES: placeholder revert (TASK-003).
    function release() external nonReentrant {
        if (state != CampaignState.SUCCEEDED) revert NotSucceeded();
        if (!payoutModeSet) revert PayoutModeNotSet();
        if (payoutMode == 1) revert NotImplemented(); // MILESTONES — TASK-003

        uint256 total = totalRaised;
        uint256 fee = total * snapFeeBps / 10_000;
        uint256 beneficiaryAmount = total - fee; // subtraction avoids any dust

        released = beneficiaryAmount;
        feePaid = fee;
        state = CampaignState.COMPLETED;

        IERC20 usdc = IERC20(config.usdc());
        if (fee > 0) {
            address _treasury = config.treasury();
            if (_treasury == address(0)) revert TreasuryNotSet();
            usdc.safeTransfer(_treasury, fee);
        }
        usdc.safeTransfer(beneficiary, beneficiaryAmount);

        emit TrancheReleased(beneficiary, beneficiaryAmount, fee);
    }

    // ── Refunds & pool settlement ─────────────────────────────────────────────

    /// @notice Pull-based refund for REFUND-preference donors in a FAILED campaign.
    function claimRefund() external nonReentrant {
        if (state != CampaignState.FAILED) revert NotFailed();
        if (swept) revert AlreadySwept();
        if (donated[msg.sender] == 0) revert NotDonor();
        if (preference[msg.sender] != 0) revert InvalidPreference(); // must be REFUND
        if (settled[msg.sender]) revert AlreadySettled();

        uint256 amount = donated[msg.sender];
        settled[msg.sender] = true;
        totalRefunded += amount;

        IERC20(config.usdc()).safeTransfer(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    /// @notice Transfer a EMERGENCY_POOL-preference donor's funds to the emergency pool.
    ///         Anyone may call on behalf of any qualifying donor.
    function settleToPool(address donor) external nonReentrant {
        if (state != CampaignState.FAILED) revert NotFailed();
        if (swept) revert AlreadySwept();
        if (donated[donor] == 0) revert NotDonor();
        if (preference[donor] != 1) revert InvalidPreference(); // must be EMERGENCY_POOL
        if (settled[donor]) revert AlreadySettled();

        address pool = config.emergencyPool();
        if (pool == address(0)) revert PoolNotConfigured();

        uint256 amount = donated[donor];
        settled[donor] = true;
        totalSentToPool += amount;

        _sendToPool(pool, amount, donorSubPoolId[donor]);
        emit SentToPool(donor, amount, donorSubPoolId[donor]);
    }

    /// @notice After refundSweepDelay, sweep the entire remaining USDC balance to the
    ///         emergency pool (general pool, subPool 0). Covers both unclaimed refunds
    ///         and unsettled EMERGENCY_POOL-preference amounts.
    function sweepUnclaimed() external nonReentrant {
        if (state != CampaignState.FAILED) revert NotFailed();
        if (swept) revert AlreadySwept();
        if (block.timestamp < uint256(endTime) + snapRefundSweepDelay) revert SweepDelayNotReached();

        address pool = config.emergencyPool();
        if (pool == address(0)) revert PoolNotConfigured();

        uint256 balance = IERC20(config.usdc()).balanceOf(address(this));
        swept = true;
        totalSentToPool += balance;

        if (balance > 0) {
            _sendToPool(pool, balance, 0);
        }
        emit Swept(balance);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function preferenceOf(address donor) external view returns (uint8) {
        return preference[donor];
    }

    function remaining() external view returns (uint256) {
        if (totalRaised >= target) return 0;
        return target - totalRaised;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /// @dev TASK-004 will augment this with a pool-side accounting call.
    function _sendToPool(
        address pool,
        uint256 amount,
        uint32 /*subPoolId*/
    )
        internal
    {
        IERC20(config.usdc()).safeTransfer(pool, amount);
    }
}
