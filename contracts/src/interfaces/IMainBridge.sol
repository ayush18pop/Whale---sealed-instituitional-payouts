// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMainBridge {
    function release(address token, address to, uint256 amount) external;

    /// @param minOut Minimum the payee must receive, AFTER the relayer fee.
    function releaseAndSwap(
        address payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 maxFee,
        address feeRecipient
    ) external;
}
