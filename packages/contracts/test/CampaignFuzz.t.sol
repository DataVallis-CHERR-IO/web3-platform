// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {CampaignFactory} from "../src/CampaignFactory.sol";
import {Campaign} from "../src/Campaign.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockEmergencyPool} from "./mocks/MockEmergencyPool.sol";

/// @notice Fuzz tests: donation clipping, fee math, threshold boundary, refunds sum.
contract CampaignFuzzTest is Test {
    PlatformConfig cfg;
    CampaignFactory factory;
    MockUSDC usdc;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address treasury = makeAddr("treasury");
    MockEmergencyPool mockPool;
    address beneficiary = makeAddr("beneficiary");

    uint256 constant TARGET = 1_000e6;

    function setUp() public {
        usdc = new MockUSDC();
        cfg = new PlatformConfig(address(usdc), admin);
        factory = new CampaignFactory(cfg, address(new Campaign()));
        mockPool = new MockEmergencyPool();

        vm.startPrank(admin);
        cfg.grantRole(cfg.OPERATOR_ROLE(), operator);
        cfg.setTreasury(treasury);
        cfg.setEmergencyPool(address(mockPool));
        vm.stopPrank();
    }

    function _newCampaign(bytes32 id) internal returns (Campaign) {
        vm.prank(operator);
        return Campaign(
            factory.createCampaign(
                CampaignFactory.CreateParams({
                    offchainId: id,
                    beneficiary: beneficiary,
                    target: TARGET,
                    deadline: uint64(block.timestamp + 30 days),
                    beneficiaryType: 0
                })
            )
        );
    }

    // ── Donation clipping ─────────────────────────────────────────────────────

    /// @notice For any amount >= minDonation, pulled amount never exceeds remaining target.
    function testFuzz_donationClipping(uint256 amount) public {
        amount = bound(amount, 1e6, 10 * TARGET);

        Campaign c = _newCampaign(keccak256("clip"));
        address donor = makeAddr("fuzz-donor");
        usdc.mint(donor, amount);
        vm.prank(donor);
        usdc.approve(address(c), amount);

        uint256 balBefore = usdc.balanceOf(donor);
        vm.prank(donor);
        c.donate(amount, 0, 0);
        uint256 pulled = balBefore - usdc.balanceOf(donor);

        assertLe(pulled, TARGET, "pulled > target");
        assertLe(c.totalRaised(), TARGET, "totalRaised > target");
        assertEq(pulled, c.donated(donor), "pulled != donated");
        assertEq(usdc.balanceOf(address(c)), c.totalRaised(), "balance mismatch");
    }

    // ── Fee math — no dust ────────────────────────────────────────────────────

    /// @notice fee + beneficiaryAmount == totalRaised exactly for any feeBps in [0,500].
    function testFuzz_feeMath(uint256 raised, uint16 feeBps) public {
        raised = bound(raised, 1e6, TARGET);
        feeBps = uint16(bound(feeBps, 0, 500));

        vm.prank(admin);
        cfg.setFeeBps(feeBps);

        Campaign c = _newCampaign(bytes32(uint256(raised) ^ uint256(feeBps)));
        address donor = makeAddr("fee-donor");
        usdc.mint(donor, raised);
        vm.prank(donor);
        usdc.approve(address(c), raised);
        vm.prank(donor);
        c.donate(raised, 0, 0);

        // Force succeed if partial raise
        if (c.totalRaised() < TARGET) {
            vm.warp(block.timestamp + 31 days);
            c.finalize();
            // Only SINGLE payout is implemented; test only when state is SUCCEEDED
            if (uint8(c.state()) != uint8(Campaign.CampaignState.SUCCEEDED)) return;
        }

        vm.prank(operator);
        c.setPayoutMode(0);

        // Warp past release delay
        vm.warp(c.endTime() + c.snapReleaseDelay() + 1);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 beneficiaryBefore = usdc.balanceOf(beneficiary);

        c.release();

        uint256 feeActual = usdc.balanceOf(treasury) - treasuryBefore;
        uint256 beneficiaryActual = usdc.balanceOf(beneficiary) - beneficiaryBefore;

        assertEq(feeActual + beneficiaryActual, c.totalRaised(), "fee+beneficiary != totalRaised");
        assertEq(c.released() + c.feePaid(), c.totalRaised(), "accounting mismatch");
        assertEq(usdc.balanceOf(address(c)), 0, "campaign has dust");
    }

    // ── Success threshold boundary ─────────────────────────────────────────────

    /// @notice Campaign succeeds iff raised * 10000 >= target * threshold.
    function testFuzz_successThreshold(uint256 raised) public {
        raised = bound(raised, 0, TARGET);

        Campaign c = _newCampaign(bytes32(raised));
        if (raised >= 1e6) {
            address donor = makeAddr("thr-donor");
            usdc.mint(donor, raised);
            vm.prank(donor);
            usdc.approve(address(c), raised);
            vm.prank(donor);
            c.donate(raised, 0, 0);
        }

        // If donate() already set state to SUCCEEDED (target reached exactly), skip finalize
        if (uint8(c.state()) == uint8(Campaign.CampaignState.LIVE)) {
            vm.warp(block.timestamp + 31 days);
            c.finalize();
        }

        uint256 threshold = uint256(TARGET) * cfg.successThresholdBps();
        bool expectedSuccess = raised * 10_000 >= threshold;

        if (expectedSuccess) {
            assertEq(uint8(c.state()), uint8(Campaign.CampaignState.SUCCEEDED), "should succeed");
        } else {
            assertEq(uint8(c.state()), uint8(Campaign.CampaignState.FAILED), "should fail");
        }
    }

    // ── Refunds sum ───────────────────────────────────────────────────────────

    /// @notice After all REFUND-preference donors claim, totalRefunded == sum of donations.
    function testFuzz_refundsSum(uint256[4] memory amounts) public {
        address[4] memory donors;
        uint256 totalExpected;

        Campaign c = _newCampaign(keccak256("refund-sum"));

        for (uint256 i; i < 4; i++) {
            amounts[i] = bound(amounts[i], 1e6, 200e6);
            donors[i] = address(uint160(0xBEEF0000 + i));
            usdc.mint(donors[i], amounts[i]);
            vm.prank(donors[i]);
            usdc.approve(address(c), amounts[i]);
        }

        // Donate while LIVE and below target
        for (uint256 i; i < 4; i++) {
            if (c.remaining() == 0) break;
            uint256 toDonate = amounts[i] > c.remaining() ? c.remaining() : amounts[i];
            if (c.remaining() > 0 && toDonate >= 1e6) {
                vm.prank(donors[i]);
                c.donate(toDonate, 0, 0); // REFUND preference
                totalExpected += c.donated(donors[i]);
            }
        }

        // Fail the campaign
        vm.warp(block.timestamp + 31 days);
        if (uint8(c.state()) == uint8(Campaign.CampaignState.LIVE)) {
            c.finalize();
        }
        if (uint8(c.state()) != uint8(Campaign.CampaignState.FAILED)) return; // succeeded — skip

        // All donors claim refund
        uint256 sumRefunded;
        for (uint256 i; i < 4; i++) {
            if (c.donated(donors[i]) > 0 && c.preference(donors[i]) == 0 && !c.settled(donors[i])) {
                uint256 bal = usdc.balanceOf(donors[i]);
                vm.prank(donors[i]);
                c.claimRefund();
                sumRefunded += usdc.balanceOf(donors[i]) - bal;
            }
        }

        assertEq(c.totalRefunded(), sumRefunded, "totalRefunded != actual sum");
        assertEq(usdc.balanceOf(address(c)), 0, "campaign not empty after all refunds");
    }

    // ── Tranche math: t1 + t2 + t3 + fee == totalRaised ────────────────────

    /// @notice For any raised amount and fee, the 3 tranches plus fee equal totalRaised exactly.
    function testFuzz_trancheMath(uint256 raised, uint16 feeBps) public {
        raised = bound(raised, TARGET / 10, TARGET); // at least 10% to succeed
        feeBps = uint16(bound(feeBps, 0, 500)); // 0..5% (MAX_FEE_BPS)

        vm.prank(admin);
        cfg.setFeeBps(feeBps);

        Campaign c = _newCampaign(keccak256(abi.encode("tranche", raised, feeBps)));

        address donor = makeAddr("tranche-donor");
        usdc.mint(donor, raised);
        vm.prank(donor);
        usdc.approve(address(c), raised);
        vm.prank(donor);
        c.donate(raised, 0, 0);

        if (c.totalRaised() < TARGET) {
            vm.warp(block.timestamp + 31 days);
            c.finalize();
            if (uint8(c.state()) != uint8(Campaign.CampaignState.SUCCEEDED)) return;
        }

        vm.prank(operator);
        c.setPayoutMode(1); // MILESTONES

        // T1 via release()
        c.release();
        uint256 t1 = c.released();
        uint256 totalFee = c.totalRaised() * feeBps / 10_000;
        assertEq(c.feePaid(), totalFee / 3, "T1 carries a third of the fee");

        // Evidence + vote → closeVote releases T2 atomically
        vm.prank(beneficiary);
        c.submitEvidence(keccak256("e1"));
        vm.prank(donor);
        c.vote(true);
        vm.warp(c.voteEnd());
        c.closeVote();
        uint256 t2 = c.released() - t1;

        // Evidence + vote → closeVote releases T3 atomically
        vm.prank(beneficiary);
        c.submitEvidence(keccak256("e2"));
        vm.prank(donor);
        c.vote(true);
        vm.warp(c.voteEnd());
        c.closeVote();
        uint256 t3 = c.released() - t1 - t2;

        assertEq(c.feePaid(), totalFee, "the three tranches carry the whole fee");
        assertEq(t1 + t2 + t3 + c.feePaid(), c.totalRaised(), "tranche+fee != totalRaised");
        assertEq(usdc.balanceOf(address(c)), 0, "campaign has dust");
        assertEq(uint8(c.state()), uint8(Campaign.CampaignState.COMPLETED));
    }

    // ── Pro-rata remainder after rejection ──────────────────────────────────

    /// @notice After T1 release and rejection, pro-rata refunds sum to rejectedRemainder.
    function testFuzz_proRataRemainder(uint256[2] memory amounts) public {
        amounts[0] = bound(amounts[0], cfg.minDonation(), TARGET / 2);
        amounts[1] = bound(amounts[1], cfg.minDonation(), TARGET - amounts[0]);
        // Need at least threshold to succeed
        if ((amounts[0] + amounts[1]) * 10_000 < TARGET * uint256(cfg.successThresholdBps())) return;

        Campaign c = _newCampaign(keccak256(abi.encode("prorata", amounts[0], amounts[1])));

        address d1 = makeAddr("prorata-d1");
        address d2 = makeAddr("prorata-d2");
        usdc.mint(d1, amounts[0]);
        usdc.mint(d2, amounts[1]);
        vm.prank(d1);
        usdc.approve(address(c), amounts[0]);
        vm.prank(d2);
        usdc.approve(address(c), amounts[1]);
        vm.prank(d1);
        c.donate(amounts[0], 0, 0);
        vm.prank(d2);
        c.donate(amounts[1], 0, 0);

        if (uint8(c.state()) != uint8(Campaign.CampaignState.SUCCEEDED)) {
            vm.warp(block.timestamp + 31 days);
            c.finalize();
            if (uint8(c.state()) != uint8(Campaign.CampaignState.SUCCEEDED)) return;
        }

        vm.prank(operator);
        c.setPayoutMode(1);
        c.release(); // T1

        // Guardian freeze → reject
        address grd = makeAddr("prorata-guardian");
        vm.startPrank(admin);
        cfg.grantRole(cfg.GUARDIAN_ROLE(), grd);
        vm.stopPrank();
        vm.prank(grd);
        c.freeze();
        vm.prank(grd);
        c.resolve(false);

        uint256 remainder = c.rejectedRemainder();
        uint256 total = c.totalRaised();

        uint256 r1 = c.donated(d1) * remainder / total;
        uint256 r2 = c.donated(d2) * remainder / total;

        vm.prank(d1);
        c.claimRefund();
        vm.prank(d2);
        c.claimRefund();

        assertEq(c.totalRefunded(), r1 + r2, "totalRefunded mismatch");
        // Rounding loss: at most 1 unit per donor
        assertLe(remainder - (r1 + r2), 2, "rounding loss > 2");
    }
}
