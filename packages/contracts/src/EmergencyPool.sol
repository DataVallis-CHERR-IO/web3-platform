// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {PlatformConfig} from "./PlatformConfig.sol";
import {CampaignFactory} from "./CampaignFactory.sol";
import {Campaign} from "./Campaign.sol";
import {IEmergencyPool} from "./IEmergencyPool.sol";

/// @title EmergencyPool
/// @notice Holds funds from failed/rejected campaigns and direct donations.
///         Sub-pool accounting, allocation proposals with checkpointed voting,
///         and Quick Realisation outflow to LIVE factory campaigns.
contract EmergencyPool is IEmergencyPool, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace256;

    // ── Types ─────────────────────────────────────────────────────────────────
    enum AllocationState {
        VOTING,
        PASSED,
        REJECTED,
        NEEDS_REVIEW,
        RESOLVED_PASS,
        RESOLVED_REJECT,
        DELIVERY_FAILED
    }

    struct Allocation {
        uint32 poolId;
        address campaign;
        uint256 amount;
        bytes32 reasonHash;
        uint256 yesVotes;
        uint256 noVotes;
        uint64 voteEnd;
        uint16 snapQuorumBps;
        uint16 snapApprovalBps;
        uint256 proposalBlock;
        AllocationState state;
    }

    // ── Immutable ─────────────────────────────────────────────────────────────
    PlatformConfig public immutable config;
    CampaignFactory public immutable factory;

    // ── Sub-pools ─────────────────────────────────────────────────────────────
    mapping(uint32 => bool) public poolExists;
    mapping(uint32 => uint256) public poolBalance;

    // ── Checkpointed contributions (change A) ─────────────────────────────────
    mapping(uint32 => mapping(address => Checkpoints.Trace256)) internal _contributed;
    mapping(uint32 => Checkpoints.Trace256) internal _totalContributed;

    // ── Campaign → source pool (change C) ─────────────────────────────────────
    // Bound when pool money is actually delivered (review L-02, ADR-061). While proposals
    // are open, the campaign is reserved for their sub-pool so two sub-pools cannot both
    // deliver to it.
    mapping(address => uint32) public fundingPool;
    mapping(address => bool) public hasFundingPool;
    mapping(address => uint32) public reservedPool;
    mapping(address => uint256) public openAllocations;

    // ── Allocations ───────────────────────────────────────────────────────────
    uint256 public allocationCount;
    mapping(uint256 => Allocation) internal _allocations;
    mapping(uint256 => mapping(address => bool)) public hasVotedAllocation;

    // ── Events ────────────────────────────────────────────────────────────────
    event SubPoolCreated(uint32 indexed poolId);
    event PoolDonated(uint32 indexed poolId, address indexed donor, uint256 amount);
    event CampaignInflow(uint32 indexed poolId, address indexed campaign, address indexed donor, uint256 amount);
    event AllocationProposed(
        uint256 indexed id, uint32 indexed poolId, address campaign, uint256 amount, bytes32 reasonHash, uint64 voteEnd
    );
    event AllocationVoted(uint256 indexed id, address indexed voter, bool approve, uint256 weight);
    event AllocationClosed(uint256 indexed id, AllocationState state);
    event AllocationDeliveryFailed(uint256 indexed id);
    event AllocationResolved(uint256 indexed id, bool approve, AllocationState state);
    event ReclaimedFromCampaign(address indexed campaign, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error NotOperator();
    error NotGuardian();
    error NotCampaign();
    error PoolAlreadyExists();
    error PoolDoesNotExist();
    error InsufficientPoolBalance();
    error AmountTooLow();
    error AmountZero();
    error NotLiveCampaign();
    error NotFactoryCampaign();
    error AllocationNotVoting();
    error AllocationNotNeedsReview();
    error VoteNotEnded();
    error VoteEnded();
    error AlreadyVoted();
    error NoVotingWeight();
    error CampaignDeadlineTooSoon();
    error PoolIdMismatch();
    error NotFailedOrRejected();
    error AllocationDoesNotExist();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(PlatformConfig _config, CampaignFactory _factory) {
        if (address(_config) == address(0) || address(_factory) == address(0)) revert ZeroAddress();
        config = _config;
        factory = _factory;
        poolExists[0] = true; // general pool always exists
    }

    // ── Sub-pool management ───────────────────────────────────────────────────

    function createSubPool(uint32 poolId) external {
        if (!config.hasRole(config.OPERATOR_ROLE(), msg.sender)) revert NotOperator();
        if (poolExists[poolId]) revert PoolAlreadyExists();
        poolExists[poolId] = true;
        emit SubPoolCreated(poolId);
    }

    // ── Inflows ───────────────────────────────────────────────────────────────

    /// @notice Direct USDC donation to a pool. Unknown poolId → general pool (0).
    function donate(uint32 poolId, uint256 amount) external nonReentrant {
        if (amount < config.minDonation()) revert AmountTooLow();
        uint32 effectivePool = poolExists[poolId] ? poolId : uint32(0);

        IERC20(config.usdc()).safeTransferFrom(msg.sender, address(this), amount);

        poolBalance[effectivePool] += amount;
        _pushContributed(effectivePool, msg.sender, amount);

        emit PoolDonated(effectivePool, msg.sender, amount);
    }

    /// @notice Called by a factory-registered Campaign after transferring USDC.
    ///   donor == address(0) → sweep inflow: balance only, no contributor credit (change D).
    ///   donor == address(this) → the pool's own money returned by a sweep: credited to the
    ///   campaign's funding sub-pool, like reclaimFromCampaign (review L-01).
    ///   otherwise → settleToPool: credits donor with actual amount (change D).
    function receiveFromCampaign(uint32 poolId, uint256 amount, address donor) external override nonReentrant {
        if (!factory.isCampaign(msg.sender)) revert NotCampaign();
        if (donor == address(this)) {
            uint32 pid = hasFundingPool[msg.sender] ? fundingPool[msg.sender] : uint32(0);
            poolBalance[pid] += amount;
            emit ReclaimedFromCampaign(msg.sender, amount);
            return;
        }
        uint32 effectivePool = poolExists[poolId] ? poolId : uint32(0);

        poolBalance[effectivePool] += amount;

        if (donor != address(0)) {
            _pushContributed(effectivePool, donor, amount);
        }

        emit CampaignInflow(effectivePool, msg.sender, donor, amount);
    }

    // ── Allocations ───────────────────────────────────────────────────────────

    /// @notice OPERATOR proposes allocating pool funds to a LIVE factory campaign.
    function proposeAllocation(uint32 poolId, address campaign, uint256 amount, bytes32 reasonHash)
        external
        returns (uint256 id)
    {
        if (!config.hasRole(config.OPERATOR_ROLE(), msg.sender)) revert NotOperator();
        if (!poolExists[poolId]) revert PoolDoesNotExist();
        if (amount == 0) revert AmountZero();
        if (!factory.isCampaign(campaign)) revert NotFactoryCampaign();
        if (Campaign(campaign).state() != Campaign.CampaignState.LIVE) revert NotLiveCampaign();
        if (amount > poolBalance[poolId]) revert InsufficientPoolBalance();

        // Source pool tracking (change C, bound on delivery — review L-02)
        if (hasFundingPool[campaign]) {
            if (fundingPool[campaign] != poolId) revert PoolIdMismatch();
        } else if (openAllocations[campaign] > 0 && reservedPool[campaign] != poolId) {
            revert PoolIdMismatch();
        }
        reservedPool[campaign] = poolId;
        openAllocations[campaign] += 1;

        uint64 vEnd = uint64(block.timestamp) + uint64(config.voteWindow());
        // Campaign must still be LIVE when vote ends (addition 2)
        if (Campaign(campaign).deadline() <= vEnd) revert CampaignDeadlineTooSoon();

        poolBalance[poolId] -= amount;

        id = allocationCount++;
        _allocations[id] = Allocation({
            poolId: poolId,
            campaign: campaign,
            amount: amount,
            reasonHash: reasonHash,
            yesVotes: 0,
            noVotes: 0,
            voteEnd: vEnd,
            snapQuorumBps: config.quorumBps(),
            snapApprovalBps: config.approvalBps(),
            proposalBlock: block.number,
            state: AllocationState.VOTING
        });

        emit AllocationProposed(id, poolId, campaign, amount, reasonHash, vEnd);
    }

    /// @notice Contributors of the allocation's pool vote. Weight = contributed at proposalBlock - 1.
    function voteAllocation(uint256 id, bool approve) external {
        if (id >= allocationCount) revert AllocationDoesNotExist();
        Allocation storage a = _allocations[id];
        if (a.state != AllocationState.VOTING) revert AllocationNotVoting();
        if (block.timestamp >= a.voteEnd) revert VoteEnded();
        if (hasVotedAllocation[id][msg.sender]) revert AlreadyVoted();

        uint256 weight = _contributed[a.poolId][msg.sender].upperLookup(a.proposalBlock - 1);
        if (weight == 0) revert NoVotingWeight();

        hasVotedAllocation[id][msg.sender] = true;

        if (approve) {
            a.yesVotes += weight;
        } else {
            a.noVotes += weight;
        }

        emit AllocationVoted(id, msg.sender, approve, weight);
    }

    /// @notice Close allocation vote after window elapsed.
    function closeAllocation(uint256 id) external nonReentrant {
        if (id >= allocationCount) revert AllocationDoesNotExist();
        Allocation storage a = _allocations[id];
        if (a.state != AllocationState.VOTING) revert AllocationNotVoting();
        if (block.timestamp < a.voteEnd) revert VoteNotEnded();

        uint256 quorumBase = _totalContributed[a.poolId].upperLookup(a.proposalBlock - 1);

        // If quorumBase == 0 (pool funded only by sweep inflows with no contributor credit),
        // quorum can never be met → NEEDS_REVIEW (Guardian decides).
        if (quorumBase == 0) {
            a.state = AllocationState.NEEDS_REVIEW;
            emit AllocationClosed(id, AllocationState.NEEDS_REVIEW);
            return;
        }

        uint256 totalVoted = a.yesVotes + a.noVotes;
        bool quorumMet = totalVoted * 10_000 >= quorumBase * uint256(a.snapQuorumBps);

        if (!quorumMet) {
            a.state = AllocationState.NEEDS_REVIEW;
            emit AllocationClosed(id, AllocationState.NEEDS_REVIEW);
        } else {
            bool approvalMet = a.yesVotes * 10_000 >= totalVoted * uint256(a.snapApprovalBps);
            if (approvalMet) {
                _deliverAllocation(a, id);
            } else {
                a.state = AllocationState.REJECTED;
                poolBalance[a.poolId] += a.amount;
                _closeOpen(a.campaign);
                emit AllocationClosed(id, AllocationState.REJECTED);
            }
        }
    }

    /// @notice Guardian resolves a NEEDS_REVIEW allocation.
    function resolveAllocation(uint256 id, bool approve) external nonReentrant {
        if (!config.hasRole(config.GUARDIAN_ROLE(), msg.sender)) revert NotGuardian();
        if (id >= allocationCount) revert AllocationDoesNotExist();
        Allocation storage a = _allocations[id];
        if (a.state != AllocationState.NEEDS_REVIEW) revert AllocationNotNeedsReview();

        if (approve) {
            _deliverAllocationResolve(a, id);
        } else {
            a.state = AllocationState.RESOLVED_REJECT;
            poolBalance[a.poolId] += a.amount;
            _closeOpen(a.campaign);
            emit AllocationResolved(id, false, AllocationState.RESOLVED_REJECT);
        }
    }

    // ── Reclaim from failed/rejected campaigns ────────────────────────────────

    /// @notice Permissionless: reclaims pool's USDC from a FAILED/REJECTED campaign.
    ///   Credits fundingPool[campaign] balance only (no contributed/totalContributed change — change C).
    function reclaimFromCampaign(address campaign) external nonReentrant {
        if (!factory.isCampaign(campaign)) revert NotFactoryCampaign();
        Campaign c = Campaign(campaign);
        Campaign.CampaignState s = c.state();
        if (s != Campaign.CampaignState.FAILED && s != Campaign.CampaignState.REJECTED) {
            revert NotFailedOrRejected();
        }

        uint256 balBefore = IERC20(config.usdc()).balanceOf(address(this));
        c.claimRefund();
        uint256 received = IERC20(config.usdc()).balanceOf(address(this)) - balBefore;

        // Credit to funding pool (change C), or general pool if none set
        uint32 pid = hasFundingPool[campaign] ? fundingPool[campaign] : uint32(0);
        poolBalance[pid] += received;

        emit ReclaimedFromCampaign(campaign, received);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getAllocation(uint256 id) external view returns (Allocation memory) {
        if (id >= allocationCount) revert AllocationDoesNotExist();
        return _allocations[id];
    }

    function contributedAt(uint32 poolId, address donor, uint256 blockNumber) external view returns (uint256) {
        return _contributed[poolId][donor].upperLookup(blockNumber);
    }

    function totalContributedAt(uint32 poolId, uint256 blockNumber) external view returns (uint256) {
        return _totalContributed[poolId].upperLookup(blockNumber);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    function _pushContributed(uint32 poolId, address donor, uint256 amount) internal {
        Checkpoints.Trace256 storage donorCkpt = _contributed[poolId][donor];
        uint256 oldVal = donorCkpt.latest();
        donorCkpt.push(block.number, oldVal + amount);

        Checkpoints.Trace256 storage totalCkpt = _totalContributed[poolId];
        uint256 oldTotal = totalCkpt.latest();
        totalCkpt.push(block.number, oldTotal + amount);
    }

    /// @dev An allocation to `campaign` reached a final state.
    function _closeOpen(address campaign) internal {
        openAllocations[campaign] -= 1;
    }

    /// @dev Pool money reached `campaign`: from now on only `poolId` may fund it (review L-02).
    function _bindFundingPool(address campaign, uint32 poolId) internal {
        if (!hasFundingPool[campaign]) {
            hasFundingPool[campaign] = true;
            fundingPool[campaign] = poolId;
        }
    }

    /// @dev Deliver allocation from closeAllocation (PASSED or DELIVERY_FAILED).
    function _deliverAllocation(Allocation storage a, uint256 id) internal {
        IERC20 usdc = IERC20(config.usdc());
        usdc.forceApprove(a.campaign, a.amount);
        try Campaign(a.campaign).donateFromPool(a.amount) returns (uint256 actual) {
            usdc.forceApprove(a.campaign, 0);
            a.state = AllocationState.PASSED;
            _closeOpen(a.campaign);
            _bindFundingPool(a.campaign, a.poolId);
            // Return unspent portion (clipping) to pool
            if (actual < a.amount) {
                poolBalance[a.poolId] += (a.amount - actual);
            }
            emit AllocationClosed(id, AllocationState.PASSED);
        } catch {
            usdc.forceApprove(a.campaign, 0);
            a.state = AllocationState.DELIVERY_FAILED;
            poolBalance[a.poolId] += a.amount;
            _closeOpen(a.campaign);
            emit AllocationDeliveryFailed(id);
        }
    }

    /// @dev Deliver allocation from resolveAllocation (RESOLVED_PASS or DELIVERY_FAILED).
    function _deliverAllocationResolve(Allocation storage a, uint256 id) internal {
        IERC20 usdc = IERC20(config.usdc());
        usdc.forceApprove(a.campaign, a.amount);
        try Campaign(a.campaign).donateFromPool(a.amount) returns (uint256 actual) {
            usdc.forceApprove(a.campaign, 0);
            a.state = AllocationState.RESOLVED_PASS;
            _closeOpen(a.campaign);
            _bindFundingPool(a.campaign, a.poolId);
            if (actual < a.amount) {
                poolBalance[a.poolId] += (a.amount - actual);
            }
            emit AllocationResolved(id, true, AllocationState.RESOLVED_PASS);
        } catch {
            usdc.forceApprove(a.campaign, 0);
            a.state = AllocationState.DELIVERY_FAILED;
            poolBalance[a.poolId] += a.amount;
            _closeOpen(a.campaign);
            emit AllocationDeliveryFailed(id);
        }
    }
}
