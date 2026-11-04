// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {DomainToken} from "../src/domain/DomainToken.sol";
import {Treasury} from "../src/domain/Treasury.sol";

contract TreasuryTest is Test {
    DomainToken token;
    Treasury treasury;

    address relayer = makeAddr("relayer");
    address monadToken = makeAddr("monadUSDC");
    address finance = makeAddr("finance");
    address a1 = makeAddr("approver1");
    address a2 = makeAddr("approver2");
    address a3 = makeAddr("approver3");
    address auditor = makeAddr("auditor");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    uint256 constant FUNDS = 10_000e6;

    event Approved(uint256 indexed batchId, address indexed approver, uint8 approvals);
    event Executed(uint256 indexed batchId);
    event Paid(uint256 indexed batchId, address indexed payee, uint256 amount);

    function setUp() public {
        token = new DomainToken(relayer, monadToken);
        address[] memory approvers = new address[](3);
        approvers[0] = a1;
        approvers[1] = a2;
        approvers[2] = a3;
        treasury = new Treasury(token, finance, approvers, 2);

        vm.prank(relayer);
        token.mintDeposit(1, address(treasury), FUNDS); // the deposit credits the Treasury
    }

    // ------------------------------------------------------------- helpers

    function _two() internal view returns (address[] memory p, uint256[] memory a) {
        p = new address[](2);
        p[0] = alice;
        p[1] = bob;
        a = new uint256[](2);
        a[0] = 300e6;
        a[1] = 200e6;
    }

    function _propose() internal returns (uint256 id) {
        (address[] memory p, uint256[] memory a) = _two();
        vm.prank(finance);
        id = treasury.propose(p, a, keccak256("november payroll"));
    }

    function _balance(address who) internal returns (uint256) {
        vm.prank(who);
        return token.balanceOf(who);
    }

    // ------------------------------------------------------------- constructor

    function test_constructor_setsRoles() public view {
        assertEq(treasury.financeLead(), finance);
        assertEq(treasury.threshold(), 2);
        assertEq(treasury.approvers().length, 3);
        assertTrue(treasury.isApprover(a1));
        assertFalse(treasury.isApprover(finance));
    }

    function test_constructor_rejectsBadConfig() public {
        address[] memory ap = new address[](2);
        ap[0] = a1;
        ap[1] = a2;

        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, finance, ap, 0); // zero threshold
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, finance, ap, 3); // threshold above approver count
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, address(0), ap, 2);
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(DomainToken(address(0)), finance, ap, 2);

        ap[1] = a1; // duplicate
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, finance, ap, 2);

        ap[1] = finance; // separation of duties: finance cannot also approve
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, finance, ap, 2);

        ap[1] = address(0);
        vm.expectRevert(Treasury.BadConfig.selector);
        new Treasury(token, finance, ap, 2);
    }

    // ------------------------------------------------------------- propose

    function test_propose_storesPendingBatch() public {
        uint256 id = _propose();
        assertEq(id, 1);
        assertEq(treasury.batchCount(), 1);

        vm.prank(finance);
        (address proposer, Treasury.Status status, uint8 approvals, uint256 total,, address[] memory p,) =
            treasury.getBatch(id);
        assertEq(proposer, finance);
        assertEq(uint8(status), uint8(Treasury.Status.Pending));
        assertEq(approvals, 0);
        assertEq(total, 500e6);
        assertEq(p.length, 2);
    }

    function test_propose_onlyFinance() public {
        (address[] memory p, uint256[] memory a) = _two();
        vm.prank(a1);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.propose(p, a, bytes32(0));
    }

    function test_propose_rejectsBadBatches() public {
        (address[] memory p, uint256[] memory a) = _two();
        vm.startPrank(finance);

        vm.expectRevert(Treasury.BadBatch.selector);
        treasury.propose(new address[](0), new uint256[](0), bytes32(0)); // empty

        uint256[] memory one = new uint256[](1);
        one[0] = 1e6;
        vm.expectRevert(Treasury.BadBatch.selector);
        treasury.propose(p, one, bytes32(0)); // length mismatch

        a[1] = 0;
        vm.expectRevert(Treasury.BadBatch.selector);
        treasury.propose(p, a, bytes32(0)); // zero amount

        a[1] = 1e6;
        p[1] = address(0);
        vm.expectRevert(Treasury.BadBatch.selector);
        treasury.propose(p, a, bytes32(0)); // zero payee

        address[] memory big = new address[](101);
        uint256[] memory bigAmt = new uint256[](101);
        for (uint256 i = 0; i < 101; i++) {
            big[i] = address(uint160(i + 1));
            bigAmt[i] = 1;
        }
        vm.expectRevert(Treasury.BadBatch.selector);
        treasury.propose(big, bigAmt, bytes32(0)); // over MAX_PAYEES
        vm.stopPrank();
    }

    // ------------------------------------------------------------- dual control (FR4)

    function test_oneApproval_doesNotPay() public {
        uint256 id = _propose();
        vm.expectEmit(true, true, false, true);
        emit Approved(id, a1, 1);
        vm.prank(a1);
        treasury.approve(id);

        assertEq(_balance(alice), 0);
        assertEq(_balance(bob), 0);
        assertEq(_balance(address(treasury)), FUNDS);
    }

    function test_secondApproval_executesPayout() public {
        uint256 id = _propose();
        vm.prank(a1);
        treasury.approve(id);

        vm.expectEmit(true, true, false, true);
        emit Paid(id, alice, 300e6);
        vm.expectEmit(true, false, false, false);
        emit Executed(id);
        vm.prank(a2);
        treasury.approve(id);

        assertEq(_balance(alice), 300e6);
        assertEq(_balance(bob), 200e6);
        assertEq(_balance(address(treasury)), FUNDS - 500e6);

        vm.prank(finance);
        (, Treasury.Status status,,,,,) = treasury.getBatch(id);
        assertEq(uint8(status), uint8(Treasury.Status.Executed));
    }

    function test_sameApproverCannotApproveTwice() public {
        uint256 id = _propose();
        vm.startPrank(a1);
        treasury.approve(id);
        vm.expectRevert(Treasury.AlreadyApproved.selector);
        treasury.approve(id);
        vm.stopPrank();
        assertEq(_balance(alice), 0); // still unpaid: one approver is not dual control
    }

    function test_onlyApproversCanApprove() public {
        uint256 id = _propose();
        vm.prank(finance); // finance cannot approve its own batch
        vm.expectRevert(Treasury.Denied.selector);
        treasury.approve(id);
        vm.prank(stranger);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.approve(id);
    }

    function test_cannotApproveExecutedOrCancelledOrUnknownBatch() public {
        uint256 id = _propose();
        vm.prank(a1);
        treasury.approve(id);
        vm.prank(a2);
        treasury.approve(id); // executes

        vm.prank(a3);
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.approve(id); // no double payout

        uint256 id2 = _propose();
        vm.prank(finance);
        treasury.cancel(id2);
        vm.prank(a1);
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.approve(id2);

        vm.prank(a1);
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.approve(999);
    }

    function test_cancel_onlyFinanceAndOnlyPending() public {
        uint256 id = _propose();
        vm.prank(a1);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.cancel(id);

        vm.prank(finance);
        treasury.cancel(id);
        vm.prank(finance);
        vm.expectRevert(Treasury.NotPending.selector);
        treasury.cancel(id);
    }

    function test_insufficientFunds_blocksExecutionAndKeepsApprovalState() public {
        address[] memory p = new address[](1);
        p[0] = alice;
        uint256[] memory a = new uint256[](1);
        a[0] = FUNDS + 1e6;
        vm.prank(finance);
        uint256 id = treasury.propose(p, a, bytes32(0));

        vm.prank(a1);
        treasury.approve(id);
        vm.prank(a2);
        vm.expectRevert(Treasury.InsufficientFunds.selector);
        treasury.approve(id);

        // the failed second approval left no trace
        vm.prank(finance);
        assertFalse(treasury.hasApproved(id, a2));
        assertEq(_balance(alice), 0);

        // after funding, the same approval goes through
        vm.prank(relayer);
        token.mintDeposit(2, address(treasury), 5e6);
        vm.prank(a2);
        treasury.approve(id);
        assertEq(_balance(alice), FUNDS + 1e6);
    }

    function test_duplicatePayeeInOneBatchAccumulates() public {
        address[] memory p = new address[](2);
        p[0] = alice;
        p[1] = alice;
        uint256[] memory a = new uint256[](2);
        a[0] = 10e6;
        a[1] = 15e6;
        vm.prank(finance);
        uint256 id = treasury.propose(p, a, bytes32(0));
        vm.prank(a1);
        treasury.approve(id);
        vm.prank(a2);
        treasury.approve(id);
        assertEq(_balance(alice), 25e6);
        vm.prank(alice);
        assertEq(treasury.paymentOf(id, alice), 25e6);
    }

    // ------------------------------------------------------------- privacy of batch data

    function test_getBatch_onlyStaff() public {
        uint256 id = _propose();
        vm.prank(stranger);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.getBatch(id);
        vm.prank(alice); // even a payee in the batch cannot see the full table
        vm.expectRevert(Treasury.Denied.selector);
        treasury.getBatch(id);

        vm.prank(a1);
        treasury.getBatch(id);
        vm.prank(finance);
        treasury.getBatch(id);
    }

    function test_payeeSeesOnlyOwnPayment() public {
        uint256 id = _propose();
        vm.prank(alice);
        assertEq(treasury.paymentOf(id, alice), 300e6);
        vm.prank(alice);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.paymentOf(id, bob); // a colleague's pay is off limits
        vm.prank(stranger);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.paymentOf(id, alice);
    }

    function test_auditorAccess_grantedByFinanceOnly() public {
        uint256 id = _propose();
        vm.prank(auditor);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.getBatch(id);

        vm.prank(a1);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.setAuditor(auditor, true);

        vm.prank(finance);
        treasury.setAuditor(auditor, true);
        vm.prank(auditor);
        (,,, uint256 total,,,) = treasury.getBatch(id);
        assertEq(total, 500e6);
        vm.prank(auditor);
        assertEq(treasury.paymentOf(id, bob), 200e6);

        vm.prank(finance);
        treasury.setAuditor(auditor, false);
        vm.prank(auditor);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.getBatch(id);
    }

    function test_treasuryBalance_onlyStaff() public {
        vm.prank(stranger);
        vm.expectRevert(Treasury.Denied.selector);
        treasury.treasuryBalance();
        vm.prank(finance);
        assertEq(treasury.treasuryBalance(), FUNDS);
    }

    // ------------------------------------------------------------- scale (demo: 50 payees)

    function test_batchOf50_paysEveryoneInOneApproval() public {
        uint256 n = 50;
        address[] memory p = new address[](n);
        uint256[] memory a = new uint256[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            p[i] = address(uint160(0x1000 + i));
            a[i] = (i + 1) * 1e6;
            total += a[i];
        }
        vm.prank(finance);
        uint256 id = treasury.propose(p, a, keccak256("50 people"));
        vm.prank(a1);
        treasury.approve(id);

        uint256 gasBefore = gasleft();
        vm.prank(a2);
        treasury.approve(id); // threshold reached: pays all 50
        uint256 used = gasBefore - gasleft();
        console2.log("gas for executing a 50-payee batch:", used);

        for (uint256 i = 0; i < n; i++) {
            assertEq(_balance(p[i]), a[i]);
        }
        assertEq(_balance(address(treasury)), FUNDS - total);
        assertLt(used, 30_000_000, "must fit under Monad's per-transaction gas limit");
    }
}
