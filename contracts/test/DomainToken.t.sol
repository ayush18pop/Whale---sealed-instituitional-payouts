// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DomainToken} from "../src/domain/DomainToken.sol";

/// @dev The attack from white paper 5.4: deploy a contract whose only purpose is to read
///      someone else's private state indirectly.
contract SnoopAttacker {
    function readBalance(DomainToken t, address victim) external view returns (uint256) {
        return t.balanceOf(victim);
    }

    function readAllowance(DomainToken t, address owner, address spender)
        external
        view
        returns (uint256)
    {
        return t.allowance(owner, spender);
    }
}

contract DomainTokenTest is Test {
    DomainToken token;
    SnoopAttacker attacker;

    address relayer = makeAddr("relayer");
    address monadToken = makeAddr("monadUSDC");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address auditor = makeAddr("auditor");

    event DepositMinted(uint256 indexed depositId, address indexed to, uint256 amount);
    event WithdrawalRequested(address indexed payee, address token, uint256 amount, uint256 nonce);

    function setUp() public {
        token = new DomainToken(relayer, monadToken);
        attacker = new SnoopAttacker();
        vm.prank(relayer);
        token.mintDeposit(1, alice, 1_000e6);
    }

    function _bal(address who) internal returns (uint256) {
        vm.prank(who);
        return token.balanceOf(who);
    }

    // ------------------------------------------------------------- minting

    function test_mintDeposit_creditsAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit DepositMinted(2, bob, 50e6);
        vm.prank(relayer);
        token.mintDeposit(2, bob, 50e6);
        assertEq(_bal(bob), 50e6);
        assertEq(token.totalSupply(), 1_050e6); // total supply is public metadata
        assertTrue(token.depositProcessed(2));
    }

    function test_mintDeposit_onlySystemRelayer() public {
        vm.prank(alice);
        vm.expectRevert(DomainToken.NotSystemRelayer.selector);
        token.mintDeposit(2, alice, 1e6);
    }

    function test_mintDeposit_cannotReplay() public {
        vm.prank(relayer);
        vm.expectRevert(DomainToken.DepositAlreadyProcessed.selector);
        token.mintDeposit(1, alice, 1_000e6); // deposit id 1 was already processed in setUp
        assertEq(_bal(alice), 1_000e6);
    }

    function test_mintDeposit_rejectsZero() public {
        vm.prank(relayer);
        vm.expectRevert(DomainToken.ZeroAmount.selector);
        token.mintDeposit(2, alice, 0);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(DomainToken.ZeroAddress.selector);
        new DomainToken(address(0), monadToken);
        vm.expectRevert(DomainToken.ZeroAddress.selector);
        new DomainToken(relayer, address(0));
    }

    // ------------------------------------------------------------- private reads (FR5, FR6)

    function test_balanceOf_ownerCanRead() public {
        assertEq(_bal(alice), 1_000e6);
    }

    function test_balanceOf_strangerDenied() public {
        vm.prank(bob);
        vm.expectRevert(DomainToken.Denied.selector);
        token.balanceOf(alice);
    }

    function test_balanceOf_snoopingContractDenied() public {
        // FR6: a contract cannot read someone else's balance indirectly.
        vm.expectRevert(DomainToken.Denied.selector);
        attacker.readBalance(token, alice);

        // Even when the victim themself triggers the call, the caller the token sees is the contract.
        vm.prank(alice);
        vm.expectRevert(DomainToken.Denied.selector);
        attacker.readBalance(token, alice);
    }

    function test_balanceOf_grantedReaderCanReadUntilRevoked() public {
        vm.prank(alice);
        token.grantReader(auditor);

        vm.prank(auditor);
        assertEq(token.balanceOf(alice), 1_000e6);

        vm.prank(alice);
        token.revokeReader(auditor);
        vm.prank(auditor);
        vm.expectRevert(DomainToken.Denied.selector);
        token.balanceOf(alice);
    }

    function test_grantReader_isPerAccount() public {
        vm.prank(alice);
        token.grantReader(auditor);
        // alice's grant says nothing about bob's balance
        vm.prank(auditor);
        vm.expectRevert(DomainToken.Denied.selector);
        token.balanceOf(bob);
    }

    function test_grantReader_rejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(DomainToken.ZeroAddress.selector);
        token.grantReader(address(0));
    }

    function test_allowance_onlyOwnerSpenderOrReader() public {
        vm.prank(alice);
        token.approve(bob, 10e6);

        vm.prank(alice);
        assertEq(token.allowance(alice, bob), 10e6);
        vm.prank(bob);
        assertEq(token.allowance(alice, bob), 10e6);

        vm.prank(auditor);
        vm.expectRevert(DomainToken.Denied.selector);
        token.allowance(alice, bob);

        vm.expectRevert(DomainToken.Denied.selector);
        attacker.readAllowance(token, alice, bob);

        vm.prank(alice);
        token.grantReader(auditor);
        vm.prank(auditor);
        assertEq(token.allowance(alice, bob), 10e6);
    }

    // ------------------------------------------------------------- transfers

    function test_transfer_movesBalances() public {
        vm.prank(alice);
        token.transfer(bob, 300e6);
        assertEq(_bal(alice), 700e6);
        assertEq(_bal(bob), 300e6);
    }

    function test_transfer_revertsWhenInsufficient() public {
        vm.prank(bob); // bob has nothing
        vm.expectRevert();
        token.transfer(alice, 1e6);
    }

    // ------------------------------------------------------------- withdrawals

    function test_requestWithdrawal_burnsAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit WithdrawalRequested(alice, monadToken, 400e6, 0);
        vm.prank(alice);
        uint256 nonce = token.requestWithdrawal(400e6);

        assertEq(nonce, 0);
        assertEq(_bal(alice), 600e6);
        assertEq(token.totalSupply(), 600e6);
        assertEq(token.withdrawalNonce(alice), 1);
    }

    function test_requestWithdrawal_nonceIncrementsPerAccount() public {
        vm.startPrank(alice);
        assertEq(token.requestWithdrawal(1e6), 0);
        assertEq(token.requestWithdrawal(1e6), 1);
        vm.stopPrank();

        vm.prank(relayer);
        token.mintDeposit(2, bob, 5e6);
        vm.prank(bob);
        assertEq(token.requestWithdrawal(1e6), 0); // bob's counter is independent
    }

    function test_requestWithdrawal_validates() public {
        vm.prank(alice);
        vm.expectRevert(DomainToken.ZeroAmount.selector);
        token.requestWithdrawal(0);

        vm.prank(alice);
        vm.expectRevert(); // more than the balance
        token.requestWithdrawal(1_000e6 + 1);
    }
}
