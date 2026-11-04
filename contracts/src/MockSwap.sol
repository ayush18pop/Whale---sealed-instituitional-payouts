// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title MockSwap
/// @notice SIMULATED swap venue for the testnet demo: fixed owner-set rates and a flat pool fee,
///         pre-funded with liquidity. It exists so the claim-and-swap path is real code with a real
///         interface; a DEX adapter implementing ISwapAdapter replaces it later.
///         Only the MainBridge may swap (PRD FR15). Every UI surface must label this "Simulated".
contract MockSwap is ISwapAdapter {
    using SafeERC20 for IERC20;

    uint256 public constant RATE_SCALE = 1e18;
    uint256 public constant FEE_BPS = 5; // 0.05% pool fee, taken from the output

    address public immutable owner;
    address public immutable bridge;
    /// @dev tokenOut per tokenIn, scaled by 1e18. Assumes both tokens share the same decimals.
    mapping(address tokenIn => mapping(address tokenOut => uint256)) public rate;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rate);
    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    error NotOwner();
    error NotBridge();
    error NoRate();
    error Slippage();
    error ZeroAddress();

    constructor(address bridge_) {
        if (bridge_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        bridge = bridge_;
    }

    function setRate(address tokenIn, address tokenOut, uint256 rate_) external {
        if (msg.sender != owner) revert NotOwner();
        rate[tokenIn][tokenOut] = rate_;
        emit RateSet(tokenIn, tokenOut, rate_);
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 r = rate[tokenIn][tokenOut];
        if (r == 0) revert NoRate();
        uint256 gross = (amountIn * r) / RATE_SCALE;
        return gross - (gross * FEE_BPS) / 10_000;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut) {
        if (msg.sender != bridge) revert NotBridge();
        amountOut = quote(tokenIn, tokenOut, amountIn);
        if (amountOut < minOut) revert Slippage();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}
