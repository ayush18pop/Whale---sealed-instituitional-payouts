// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";
import {
    IPoolManagerLite, IUnlockCallbackLite, PoolKey, SwapParams, DeltaLib
} from "./interfaces/IPoolManagerLite.sol";

/// @title UniswapV4Adapter
/// @notice Real Uniswap v4 swap venue for MainBridge's claim-and-swap. Talks directly to the PoolManager
///         (unlock -> swap -> settle input -> take output), so no Permit2 or router is involved.
///         Exact-input only; reverts (never partially fills) if the pool cannot absorb the whole input, and
///         reverts if the output is below `minOut`. Only the bridge may swap (PRD FR15).
/// @dev One adapter serves one pool (fixed pair, fee, tick spacing, no hooks).
contract UniswapV4Adapter is ISwapAdapter, IUnlockCallbackLite {
    using SafeERC20 for IERC20;

    // TickMath.MIN_SQRT_PRICE + 1 and MAX_SQRT_PRICE - 1 (v4-core 1.0.2): "no price limit" for a swap.
    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IPoolManagerLite public immutable poolManager;
    address public immutable bridge;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient
    );

    error NotBridge();
    error NotPoolManager();
    error WrongPair();
    error BadConfig();
    error PartialFill();
    error Slippage();

    constructor(address poolManager_, address bridge_, address tokenA, address tokenB, uint24 fee_, int24 tickSpacing_) {
        if (poolManager_ == address(0) || bridge_ == address(0) || tokenA == tokenB) revert BadConfig();
        if (tokenA == address(0) || tokenB == address(0)) revert BadConfig(); // ERC-20 pairs only
        poolManager = IPoolManagerLite(poolManager_);
        bridge = bridge_;
        (currency0, currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
        tickSpacing = tickSpacing_;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, fee, tickSpacing, address(0));
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != bridge) revert NotBridge();
        bool zeroForOne = tokenIn == currency0 && tokenOut == currency1;
        if (!zeroForOne && !(tokenIn == currency1 && tokenOut == currency0)) revert WrongPair();
        if (amountIn == 0 || amountIn > uint256(uint128(type(int128).max))) revert PartialFill();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        bytes memory result = poolManager.unlock(abi.encode(zeroForOne, amountIn, minOut, recipient));
        amountOut = abi.decode(result, (uint256));
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool zeroForOne, uint256 amountIn, uint256 minOut, address recipient) =
            abi.decode(data, (bool, uint256, uint256, address));

        int256 delta = poolManager.swap(
            poolKey(),
            SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
            ""
        );
        int128 d0 = DeltaLib.amount0(delta);
        int128 d1 = DeltaLib.amount1(delta);
        int128 inDelta = zeroForOne ? d0 : d1; // negative: we owe the pool
        int128 outDelta = zeroForOne ? d1 : d0; // positive: the pool owes us

        // The pool must absorb the entire input; otherwise revert instead of returning a partial fill.
        if (inDelta != -int128(uint128(amountIn)) || outDelta <= 0) revert PartialFill();
        uint256 amountOut = uint256(uint128(outDelta));
        if (amountOut < minOut) revert Slippage();

        address tokenIn = zeroForOne ? currency0 : currency1;
        address tokenOut = zeroForOne ? currency1 : currency0;
        poolManager.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(poolManager), amountIn);
        poolManager.settle();
        poolManager.take(tokenOut, recipient, amountOut);
        return abi.encode(amountOut);
    }
}
