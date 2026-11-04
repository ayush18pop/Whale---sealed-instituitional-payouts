// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The only surface MainBridge needs from a swap venue. Implementations: MockSwap (testnet demo),
///         a real DEX adapter later. The caller must have approved `amountIn` of `tokenIn`.
interface ISwapAdapter {
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 amountOut);
}
