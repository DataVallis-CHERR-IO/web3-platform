// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PlatformConfig} from "./PlatformConfig.sol";
import {IEmergencyPool} from "./IEmergencyPool.sol";

/// @title Campaign
/// @notice Per-campaign USDC escrow deployed as an EIP-1167 clone by CampaignFactory.
///         Non-upgradeable; the constructor disables initializers on the implementation.
///         Supports SINGLE payout and MILESTONES (3-tranche) payout with donor voting.
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
///  slot 11: swept(1B)|tranchesReleased(1B)|currentRound(1B)|prevState(1B)|frozenAt(8B)|voteEnd(8B)|snapReleaseDelay(4B)|settlementStart(8B)
///  slot 12: yesVotes
///  slot 13: noVotes
///  slot 14: rejectedRemainder
///  slot 15: poolDonated
///  mappings: donated, preference, donorSubPoolId, settled, hasVoted
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

    // ── Packed slot 11 ────────────────────────────────────────────────────────
    bool public swept;
    uint8 public tranchesReleased; // 0..3
    uint8 public currentRound; // 0 or 1 (vote round after T1 or T2)
    CampaignState public prevState; // stored on freeze for restore
    uint64 public frozenAt; // timestamp of freeze (for vote deadline extension)
    uint64 public voteEnd; // current voting window deadline
    uint32 public snapReleaseDelay; // snapshotted release delay for SINGLE
    uint64 public settlementStart; // set on FAILED or REJECTED for sweep delay

    // ── Slots 12-14 ───────────────────────────────────────────────────────────
    uint256 public yesVotes;
    uint256 public noVotes;
    uint256 public rejectedRemainder; // totalRaised - released - feePaid at rejection

    // ── Slot 15 ─────────────────────────────────────────────────────────────
    uint256 public poolDonated; // total USDC from donateFromPool (change B)

    // ── Mappings ──────────────────────────────────────────────────────────────
    mapping(address => uint256) public donated;
    mapping(address => uint8) public preference; // 0 = REFUND, 1 = EMERGENCY_POOL
    mapping(address => uint32) public donorSubPoolId;
    mapping(address => bool) public settled; // set by claimRefund OR settleToPool
    mapping(address => mapping(uint8 => bool)) public hasVoted;

    // ── Events ────────────────────────────────────────────────────────────────
    event Donated(address indexed donor, uint256 amount, uint8 preference, uint32 subPoolId);
    event PreferenceSet(address indexed donor, uint8 preference, uint32 subPoolId);
    event Finalized(CampaignState indexed newState);
    event PayoutModeSet(uint8 mode);
    event TrancheReleased(address indexed beneficiary, uint256 amount, uint256 fee);
    event Refunded(address indexed donor, uint256 amount);
    event SentToPool(address indexed donor, uint256 amount, uint32 subPoolId);
    event Swept(uint256 amount);
    event EvidenceSubmitted(uint8 indexed round, bytes32 bundleHash, uint64 voteEnd);
    event Voted(uint8 indexed round, address indexed voter, bool approve, uint256 weight);
    event VoteClosed(uint8 indexed round, uint256 yesVotes, uint256 noVotes, CampaignState outcome);
    event Frozen(CampaignState indexed prevState);
    event Resolved(bool approve, CampaignState indexed newState);

    // ── Errors ────────────────────────────────────────────────────────────────
    error NotLive();
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
    error ZeroAddress();
    error NotBeneficiary();
    error NotGuardian();
    error NotPaying();
    error NotVoting();
    error VoteNotEnded();
    error VoteEnded();
    error AlreadyVoted();
    error CannotFreeze();
    error CannotResolve();
    error ReleaseDelayNotReached();
    error NotFailedOrRejected();
    error NotPool();

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
        snapReleaseDelay = _config.releaseDelay();
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

    /// @notice Pool donates USDC to this campaign. Clips to remaining target.
    ///   Callable only by config.emergencyPool(). Credited as donation from pool address with REFUND pref.
    ///   Returns actual amount donated (may be < amount if clipped).
    function donateFromPool(uint256 amount) external nonReentrant returns (uint256 actual) {
        if (msg.sender != config.emergencyPool()) revert NotPool();
        if (state != CampaignState.LIVE) revert NotLive();
        if (block.timestamp >= deadline) revert PastDeadline();

        uint256 rem = target - totalRaised;
        actual = amount > rem ? rem : amount;

        IERC20(config.usdc()).safeTransferFrom(msg.sender, address(this), actual);

        donated[msg.sender] += actual;
        totalRaised += actual;
        poolDonated += actual;
        preference[msg.sender] = 0; // REFUND — funds return to pool on failure

        emit Donated(msg.sender, actual, 0, 0);

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
            settlementStart = endTime;
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

    /// @notice Execute payout. Only valid from SUCCEEDED state.
    ///   SINGLE mode: enforces releaseDelay after endTime, fee → treasury, rest → beneficiary, state → COMPLETED.
    ///   MILESTONES mode: releases T1 only (T2/T3 are released atomically by closeVote or resolve).
    function release() external nonReentrant {
        if (state != CampaignState.SUCCEEDED) revert NotSucceeded();
        if (!payoutModeSet) revert PayoutModeNotSet();

        if (payoutMode == 0) {
            // ── SINGLE ──────────────────────────────────────────────────────
            if (block.timestamp < uint256(endTime) + snapReleaseDelay) revert ReleaseDelayNotReached();

            uint256 total = totalRaised;
            uint256 fee = total * snapFeeBps / 10_000;
            uint256 beneficiaryAmount = total - fee;

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
        } else {
            // ── MILESTONES T1 ───────────────────────────────────────────────
            _releaseNextTranche();
        }
    }

    /// @dev Internal: release the next milestone tranche.
    ///      Caller is responsible for state validation.
    ///      T1: called from release() (SUCCEEDED). T2/T3: called from closeVote() or resolve().
    function _releaseNextTranche() internal {
        uint8 t = tranchesReleased;

        uint256 net = totalRaised - (totalRaised * snapFeeBps / 10_000);
        uint256 fee = 0;
        uint256 trancheAmt;

        if (t == 0) {
            // T1: net/3, pay full fee alongside
            trancheAmt = net / 3;
            fee = totalRaised * snapFeeBps / 10_000;
        } else if (t == 1) {
            // T2: net/3
            trancheAmt = net / 3;
        } else {
            // T3: remainder absorbs rounding dust
            trancheAmt = net - (net / 3) - (net / 3);
        }

        tranchesReleased = t + 1;
        released += trancheAmt;
        feePaid += fee;

        if (t + 1 == 3) {
            state = CampaignState.COMPLETED;
        } else {
            state = CampaignState.PAYING;
        }

        IERC20 usdc = IERC20(config.usdc());
        if (fee > 0) {
            address _treasury = config.treasury();
            if (_treasury == address(0)) revert TreasuryNotSet();
            usdc.safeTransfer(_treasury, fee);
        }
        usdc.safeTransfer(beneficiary, trancheAmt);

        emit TrancheReleased(beneficiary, trancheAmt, fee);
    }

    // ── Milestones: evidence & voting ─────────────────────────────────────────

    /// @notice Beneficiary submits evidence for the next milestone, opening a vote window.
    ///         PAYING → VOTING. Only after T1 or T2 (tranchesReleased == 1 or 2).
    function submitEvidence(bytes32 bundleHash) external {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        if (state != CampaignState.PAYING) revert NotPaying();

        currentRound = tranchesReleased - 1; // round 0 after T1, round 1 after T2
        yesVotes = 0;
        noVotes = 0;
        // forge-lint: disable-next-line(unsafe-typecast)
        voteEnd = uint64(block.timestamp) + uint64(snapVoteWindow);
        state = CampaignState.VOTING;

        emit EvidenceSubmitted(currentRound, bundleHash, voteEnd);
    }

    /// @notice Donor casts a weighted vote. Weight = donated[msg.sender] (snapshot-locked).
    function vote(bool approve) external {
        if (state != CampaignState.VOTING) revert NotVoting();
        if (block.timestamp >= voteEnd) revert VoteEnded();
        if (donated[msg.sender] == 0) revert NotDonor();
        if (hasVoted[msg.sender][currentRound]) revert AlreadyVoted();

        hasVoted[msg.sender][currentRound] = true;
        uint256 weight = donated[msg.sender];

        if (approve) {
            yesVotes += weight;
        } else {
            noVotes += weight;
        }

        emit Voted(currentRound, msg.sender, approve, weight);
    }

    /// @notice Close vote after the window has elapsed.
    ///         Quorum: (yes + no) * 10_000 >= totalRaised * snapQuorumBps
    ///         Approval: yes * 10_000 >= (yes + no) * snapApprovalBps
    ///         quorum not met → NEEDS_REVIEW
    ///         quorum met + approval met → release next tranche atomically
    ///         quorum met + approval not met → REJECTED
    function closeVote() external nonReentrant {
        if (state != CampaignState.VOTING) revert NotVoting();
        if (block.timestamp < voteEnd) revert VoteNotEnded();

        // Quorum base excludes pool-donated amounts (change B).
        // If fully pool-funded (quorumBase == 0), always → NEEDS_REVIEW.
        uint256 quorumBase = totalRaised - poolDonated;
        if (quorumBase == 0) {
            state = CampaignState.NEEDS_REVIEW;
            emit VoteClosed(currentRound, yesVotes, noVotes, CampaignState.NEEDS_REVIEW);
            return;
        }

        uint256 totalVoted = yesVotes + noVotes;
        bool quorumMet = totalVoted * 10_000 >= quorumBase * uint256(snapQuorumBps);

        if (!quorumMet) {
            state = CampaignState.NEEDS_REVIEW;
            emit VoteClosed(currentRound, yesVotes, noVotes, CampaignState.NEEDS_REVIEW);
        } else {
            bool approvalMet = yesVotes * 10_000 >= totalVoted * uint256(snapApprovalBps);
            if (approvalMet) {
                // Atomic release: T2 → PAYING or T3 → COMPLETED
                _releaseNextTranche();
                emit VoteClosed(currentRound, yesVotes, noVotes, state);
            } else {
                // Quorum met but approval failed → REJECTED
                _reject();
                emit VoteClosed(currentRound, yesVotes, noVotes, CampaignState.REJECTED);
            }
        }
    }

    // ── Guardian freeze/resolve ────────────────────────────────────────────────

    /// @notice Guardian freezes a campaign. Allowed from LIVE, SUCCEEDED, PAYING, VOTING, NEEDS_REVIEW.
    function freeze() external {
        if (!config.hasRole(config.GUARDIAN_ROLE(), msg.sender)) revert NotGuardian();
        CampaignState s = state;
        if (
            s != CampaignState.LIVE && s != CampaignState.SUCCEEDED && s != CampaignState.PAYING
                && s != CampaignState.VOTING && s != CampaignState.NEEDS_REVIEW
        ) revert CannotFreeze();

        prevState = s;
        // forge-lint: disable-next-line(unsafe-typecast)
        frozenAt = uint64(block.timestamp);
        state = CampaignState.FROZEN;

        emit Frozen(s);
    }

    /// @notice Guardian resolves a frozen or needs-review campaign.
    ///   approve=true from FROZEN: restore prevState (if prevState==VOTING, extend voteEnd).
    ///   approve=true from NEEDS_REVIEW: release next tranche atomically (Guardian override).
    ///   approve=false: → REJECTED (pro-rata refunds based on rejectedRemainder).
    function resolve(bool approve) external nonReentrant {
        if (!config.hasRole(config.GUARDIAN_ROLE(), msg.sender)) revert NotGuardian();
        CampaignState s = state;
        if (s != CampaignState.FROZEN && s != CampaignState.NEEDS_REVIEW) revert CannotResolve();

        if (approve) {
            if (s == CampaignState.FROZEN) {
                CampaignState newState = prevState;
                // If we were in VOTING, extend voteEnd by the frozen duration
                if (newState == CampaignState.VOTING) {
                    // forge-lint: disable-next-line(unsafe-typecast)
                    uint64 frozenDuration = uint64(block.timestamp) - frozenAt;
                    voteEnd += frozenDuration;
                }
                state = newState;
                emit Resolved(true, newState);
            } else {
                // NEEDS_REVIEW → Guardian overrides: release next tranche atomically
                _releaseNextTranche();
                emit Resolved(true, state);
            }
        } else {
            _reject();
            emit Resolved(false, CampaignState.REJECTED);
        }
    }

    /// @dev Sets REJECTED state with pro-rata remainder calculation.
    function _reject() internal {
        rejectedRemainder = totalRaised - released - feePaid;
        // forge-lint: disable-next-line(unsafe-typecast)
        settlementStart = uint64(block.timestamp);
        state = CampaignState.REJECTED;
    }

    // ── Refunds & pool settlement ─────────────────────────────────────────────

    /// @notice Pull-based refund for REFUND-preference donors.
    ///   FAILED: refund = donated[donor] (full amount).
    ///   REJECTED: refund = donated[donor] * rejectedRemainder / totalRaised (pro-rata of what's left).
    function claimRefund() external nonReentrant {
        CampaignState s = state;
        if (s != CampaignState.FAILED && s != CampaignState.REJECTED) revert NotFailedOrRejected();
        if (swept) revert AlreadySwept();
        if (donated[msg.sender] == 0) revert NotDonor();
        if (preference[msg.sender] != 0) revert InvalidPreference(); // must be REFUND
        if (settled[msg.sender]) revert AlreadySettled();

        uint256 amount;
        if (s == CampaignState.FAILED) {
            amount = donated[msg.sender];
        } else {
            // REJECTED: pro-rata share of rejectedRemainder
            amount = donated[msg.sender] * rejectedRemainder / totalRaised;
        }

        settled[msg.sender] = true;
        totalRefunded += amount;

        IERC20(config.usdc()).safeTransfer(msg.sender, amount);
        emit Refunded(msg.sender, amount);
    }

    /// @notice Transfer a EMERGENCY_POOL-preference donor's funds to the emergency pool.
    ///   FAILED: amount = donated[donor]. REJECTED: pro-rata of rejectedRemainder.
    function settleToPool(address donor) external nonReentrant {
        CampaignState s = state;
        if (s != CampaignState.FAILED && s != CampaignState.REJECTED) revert NotFailedOrRejected();
        if (swept) revert AlreadySwept();
        if (donated[donor] == 0) revert NotDonor();
        if (preference[donor] != 1) revert InvalidPreference(); // must be EMERGENCY_POOL
        if (settled[donor]) revert AlreadySettled();

        address pool = config.emergencyPool();
        if (pool == address(0)) revert PoolNotConfigured();

        uint256 amount;
        if (s == CampaignState.FAILED) {
            amount = donated[donor];
        } else {
            amount = donated[donor] * rejectedRemainder / totalRaised;
        }

        settled[donor] = true;
        totalSentToPool += amount;

        _sendToPool(pool, amount, donorSubPoolId[donor], donor);
        emit SentToPool(donor, amount, donorSubPoolId[donor]);
    }

    /// @notice After refundSweepDelay from settlementStart, sweep remaining balance to pool.
    ///   settlementStart = endTime for FAILED, block.timestamp of rejection for REJECTED.
    function sweepUnclaimed() external nonReentrant {
        CampaignState s = state;
        if (s != CampaignState.FAILED && s != CampaignState.REJECTED) revert NotFailedOrRejected();
        if (swept) revert AlreadySwept();
        if (block.timestamp < uint256(settlementStart) + snapRefundSweepDelay) revert SweepDelayNotReached();

        address pool = config.emergencyPool();
        if (pool == address(0)) revert PoolNotConfigured();

        uint256 balance = IERC20(config.usdc()).balanceOf(address(this));
        swept = true;
        totalSentToPool += balance;

        if (balance > 0) {
            _sendToPool(pool, balance, 0, address(0));
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

    /// @dev Transfers USDC to the pool and reports the inflow for accounting.
    ///   donor == address(0) for sweeps (no contributor credit on pool side).
    function _sendToPool(address pool, uint256 amount, uint32 subPoolId, address donor) internal {
        IERC20(config.usdc()).safeTransfer(pool, amount);
        IEmergencyPool(pool).receiveFromCampaign(subPoolId, amount, donor);
    }
}
