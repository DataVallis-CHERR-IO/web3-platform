// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {PlatformConfig} from "../../src/PlatformConfig.sol";
import {CampaignFactory} from "../../src/CampaignFactory.sol";
import {Campaign} from "../../src/Campaign.sol";
import {EmergencyPool} from "../../src/EmergencyPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Handler for the EmergencyPool invariant suite.
///         Ghost variables track inflight allocation amounts for cross-checking.
contract PoolHandler is CommonBase, StdCheats, StdUtils {
    EmergencyPool public pool;
    CampaignFactory public factory;
    PlatformConfig public cfg;
    MockUSDC public usdc;
    address public operator;
    address public guardian;
    address public beneficiary;

    // Fixed actor set
    address[] public actors;

    // Allocation tracking
    uint256[] public votingAllocations;
    uint256[] public needsReviewAllocations;
    mapping(uint256 => uint256) public allocAmounts;

    // Campaign tracking
    address[] public liveCampaigns;
    uint256 public campaignNonce;

    // Ghost accounting
    uint256 public ghost_inflightAmount;

    // Execution counters
    uint256 public exec_donate;
    uint256 public exec_receiveFromCampaign_settle;
    uint256 public exec_receiveFromCampaign_sweep;
    uint256 public exec_propose;
    uint256 public exec_vote;
    uint256 public exec_close_passed;
    uint256 public exec_close_rejected;
    uint256 public exec_close_needsReview;
    uint256 public exec_close_deliveryFailed;
    uint256 public exec_close_clipped;
    uint256 public exec_resolve_pass;
    uint256 public exec_resolve_reject;
    uint256 public exec_reclaim_failed;
    uint256 public exec_reclaim_rejected;

    constructor(
        EmergencyPool _pool,
        CampaignFactory _factory,
        PlatformConfig _cfg,
        MockUSDC _usdc,
        address _operator,
        address _guardian,
        address _beneficiary
    ) {
        pool = _pool;
        factory = _factory;
        cfg = _cfg;
        usdc = _usdc;
        operator = _operator;
        guardian = _guardian;
        beneficiary = _beneficiary;

        for (uint256 i; i < 5; i++) {
            actors.push(address(uint160(0xB000 + i)));
        }
    }

    // ── Handlers ────────────────────────────────────────────────────────────────

    function handler_donate(uint256 actorSeed, uint256 amount) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        amount = bound(amount, cfg.minDonation(), 10_000e6);
        usdc.mint(actor, amount);
        vm.startPrank(actor);
        usdc.approve(address(pool), amount);
        pool.donate(0, amount);
        vm.stopPrank();
        vm.roll(block.number + 1);
        exec_donate++;
    }

    function handler_propose(uint256 amount) external {
        if (pool.poolBalance(0) == 0) return;
        amount = bound(amount, 1, pool.poolBalance(0));
        address camp = _ensureLiveCampaign();
        if (camp == address(0)) return;
        vm.prank(operator);
        uint256 id = pool.proposeAllocation(0, camp, amount, keccak256(abi.encode(campaignNonce)));
        votingAllocations.push(id);
        allocAmounts[id] = amount;
        ghost_inflightAmount += amount;
        exec_propose++;
    }

    function handler_vote(uint256 allocIdx, uint256 actorSeed, bool approve_) external {
        if (votingAllocations.length == 0) return;
        uint256 id = votingAllocations[bound(allocIdx, 0, votingAllocations.length - 1)];
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        if (a.state != EmergencyPool.AllocationState.VOTING) return;
        if (block.timestamp >= a.voteEnd) return;
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        if (pool.hasVotedAllocation(id, actor)) return;
        if (pool.contributedAt(0, actor, a.proposalBlock - 1) == 0) return;
        vm.prank(actor);
        pool.voteAllocation(id, approve_);
        exec_vote++;
    }

    function handler_close(uint256 allocIdx) external {
        if (votingAllocations.length == 0) return;
        uint256 idx = bound(allocIdx, 0, votingAllocations.length - 1);
        uint256 id = votingAllocations[idx];
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        if (a.state != EmergencyPool.AllocationState.VOTING) {
            _removeVoting(idx);
            return;
        }
        if (block.timestamp < a.voteEnd) vm.warp(a.voteEnd);
        pool.closeAllocation(id);
        ghost_inflightAmount -= allocAmounts[id];
        _removeVoting(idx);
        a = pool.getAllocation(id);
        if (a.state == EmergencyPool.AllocationState.PASSED) {
            exec_close_passed++;
        } else if (a.state == EmergencyPool.AllocationState.REJECTED) {
            exec_close_rejected++;
        } else if (a.state == EmergencyPool.AllocationState.NEEDS_REVIEW) {
            needsReviewAllocations.push(id);
            ghost_inflightAmount += allocAmounts[id];
            exec_close_needsReview++;
        } else if (a.state == EmergencyPool.AllocationState.DELIVERY_FAILED) {
            exec_close_deliveryFailed++;
        }
    }

    function handler_resolve(uint256 allocIdx, bool approve_) external {
        if (needsReviewAllocations.length == 0) return;
        uint256 idx = bound(allocIdx, 0, needsReviewAllocations.length - 1);
        uint256 id = needsReviewAllocations[idx];
        EmergencyPool.Allocation memory a = pool.getAllocation(id);
        if (a.state != EmergencyPool.AllocationState.NEEDS_REVIEW) {
            _removeNeedsReview(idx);
            return;
        }
        vm.prank(guardian);
        pool.resolveAllocation(id, approve_);
        ghost_inflightAmount -= allocAmounts[id];
        _removeNeedsReview(idx);
        a = pool.getAllocation(id);
        if (a.state == EmergencyPool.AllocationState.RESOLVED_PASS) {
            exec_resolve_pass++;
        } else if (a.state == EmergencyPool.AllocationState.RESOLVED_REJECT) {
            exec_resolve_reject++;
        } else if (a.state == EmergencyPool.AllocationState.DELIVERY_FAILED) {
            exec_close_deliveryFailed++;
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    function _ensureLiveCampaign() internal returns (address) {
        uint64 minDeadline = uint64(block.timestamp) + uint64(cfg.voteWindow()) + 1;
        for (uint256 i; i < liveCampaigns.length; i++) {
            Campaign c = Campaign(liveCampaigns[i]);
            if (c.state() == Campaign.CampaignState.LIVE && c.deadline() > minDeadline) {
                return liveCampaigns[i];
            }
        }
        // Create new campaign — deadline must be within factory's [1 day, 90 days] range
        uint64 dl = uint64(block.timestamp + 30 days);
        vm.prank(operator);
        try factory.createCampaign(
            CampaignFactory.CreateParams({
                offchainId: keccak256(abi.encode("pool-inv-", campaignNonce++)),
                beneficiary: beneficiary,
                target: 100_000_000e6,
                deadline: dl,
                beneficiaryType: 0
            })
        ) returns (
            address camp
        ) {
            liveCampaigns.push(camp);
            return camp;
        } catch {
            return address(0);
        }
    }

    function _removeVoting(uint256 idx) internal {
        votingAllocations[idx] = votingAllocations[votingAllocations.length - 1];
        votingAllocations.pop();
    }

    function _removeNeedsReview(uint256 idx) internal {
        needsReviewAllocations[idx] = needsReviewAllocations[needsReviewAllocations.length - 1];
        needsReviewAllocations.pop();
    }

    // ── Views ───────────────────────────────────────────────────────────────────

    function votingCount() external view returns (uint256) {
        return votingAllocations.length;
    }

    function needsReviewCount() external view returns (uint256) {
        return needsReviewAllocations.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}
