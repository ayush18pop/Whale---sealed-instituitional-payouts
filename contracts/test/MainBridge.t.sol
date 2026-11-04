// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MainBridge} from "../src/MainBridge.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @dev Burns 1% on every transfer, like a fee-on-transfer token.
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MainBridgeTest is Test {
    TestUSDC usdc;
    MainBridge bridge;
    address hub = makeAddr("hub");
    address alice = makeAddr("alice");
    address domainRecipient = makeAddr("domainRecipient");

    event Deposit(
        uint256 indexed depositId,
        address indexed token,
        address indexed from,
        address domainRecipient,
        uint256 amount
    );
    event Released(address indexed token, address indexed to, uint256 amount);

    function setUp() public {
        usdc = new TestUSDC();
        bridge = new MainBridge();
        bridge.setHub(hub);
        bridge.setTokenAllowed(address(usdc), true);
        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(bridge), type(uint256).max);
    }

    function test_deposit_locksTokensAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit Deposit(1, address(usdc), alice, domainRecipient, 400e6);
        vm.prank(alice);
        uint256 id = bridge.deposit(address(usdc), 400e6, domainRecipient);

        assertEq(id, 1);
        assertEq(bridge.depositCount(), 1);
        assertEq(usdc.balanceOf(address(bridge)), 400e6);
        assertEq(usdc.balanceOf(alice), 600e6);
    }

    function test_deposit_idsIncrement() public {
        vm.startPrank(alice);
        assertEq(bridge.deposit(address(usdc), 1e6, domainRecipient), 1);
        assertEq(bridge.deposit(address(usdc), 1e6, domainRecipient), 2);
        vm.stopPrank();
    }

    function test_deposit_revertsForDisallowedToken() public {
        TestUSDC other = new TestUSDC();
        other.mint(alice, 10e6);
        vm.startPrank(alice);
        other.approve(address(bridge), type(uint256).max);
        vm.expectRevert(MainBridge.TokenNotAllowed.selector);
        bridge.deposit(address(other), 10e6, domainRecipient);
        vm.stopPrank();
    }

    function test_deposit_revertsOnZeroAmountOrRecipient() public {
        vm.startPrank(alice);
        vm.expectRevert(MainBridge.ZeroAmount.selector);
        bridge.deposit(address(usdc), 0, domainRecipient);
        vm.expectRevert(MainBridge.ZeroAddress.selector);
        bridge.deposit(address(usdc), 1e6, address(0));
        vm.stopPrank();
    }

    function test_deposit_revertsWithoutAllowance() public {
        address bob = makeAddr("bob");
        usdc.mint(bob, 5e6);
        vm.prank(bob);
        vm.expectRevert();
        bridge.deposit(address(usdc), 5e6, domainRecipient);
    }

    function test_deposit_revertsForFeeOnTransferToken() public {
        FeeToken fee = new FeeToken();
        bridge.setTokenAllowed(address(fee), true);
        fee.mint(alice, 100e6);
        vm.startPrank(alice);
        fee.approve(address(bridge), type(uint256).max);
        vm.expectRevert(MainBridge.BalanceDeltaMismatch.selector);
        bridge.deposit(address(fee), 100e6, domainRecipient);
        vm.stopPrank();
    }

    function test_release_onlyHub() public {
        vm.prank(alice);
        bridge.deposit(address(usdc), 400e6, domainRecipient);

        vm.expectRevert(MainBridge.NotHub.selector);
        bridge.release(address(usdc), alice, 1e6);

        vm.expectEmit(true, true, false, true);
        emit Released(address(usdc), alice, 100e6);
        vm.prank(hub);
        bridge.release(address(usdc), alice, 100e6);

        assertEq(usdc.balanceOf(address(bridge)), 300e6);
        assertEq(usdc.balanceOf(alice), 700e6);
    }

    function test_release_revertsWhenBridgeUnderfunded() public {
        vm.prank(hub);
        vm.expectRevert();
        bridge.release(address(usdc), alice, 1e6);
    }

    function test_setHub_onlyOwnerOnceNonZero() public {
        MainBridge fresh = new MainBridge();
        vm.prank(alice);
        vm.expectRevert(MainBridge.NotOwner.selector);
        fresh.setHub(hub);

        vm.expectRevert(MainBridge.ZeroAddress.selector);
        fresh.setHub(address(0));

        fresh.setHub(hub);
        vm.expectRevert(MainBridge.HubAlreadySet.selector);
        fresh.setHub(makeAddr("other"));
    }

    function test_setTokenAllowed_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(MainBridge.NotOwner.selector);
        bridge.setTokenAllowed(address(usdc), false);
    }
}
