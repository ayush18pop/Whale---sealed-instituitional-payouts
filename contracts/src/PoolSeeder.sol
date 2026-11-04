// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    IPoolManagerLite,
    IUnlockCallbackLite,
    PoolKey,
    SwapParams,
    ModifyLiquidityParams,
    DeltaLib
} from "./interfaces/IPoolManagerLite.sol";

/// @title PoolSeeder
/// @notice DEMO/TESTNET helper (owner-only): creates the mock-token pool on Uniswap v4, adds liquidity, and can
///         swap through the pool to move its price on purpose (to demonstrate the slippage guard).
///         It must hold the tokens it deposits; both mock tokens are open-mint, so the deployer mints to it first.
contract PoolSeeder is IUnlockCallbackLite {
    using SafeERC20 for IERC20;

    uint160 internal constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;
    uint8 internal constant MODE_ADD = 1;
    uint8 internal constant MODE_SWAP = 2;

    IPoolManagerLite public immutable poolManager;
    address public immutable owner;
    address public immutable currency0;
    address public immutable currency1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;

    error NotOwner();
    error NotPoolManager();
    error BadConfig();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address poolManager_, address tokenA, address tokenB, uint24 fee_, int24 tickSpacing_) {
        if (poolManager_ == address(0) || tokenA == tokenB || tokenA == address(0) || tokenB == address(0)) {
            revert BadConfig();
        }
        owner = msg.sender;
        poolManager = IPoolManagerLite(poolManager_);
        (currency0, currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
        tickSpacing = tickSpacing_;
    }

    function poolKey() public view returns (PoolKey memory) {
        return PoolKey(currency0, currency1, fee, tickSpacing, address(0));
    }

    function initializePool(uint160 sqrtPriceX96) external onlyOwner {
        poolManager.initialize(poolKey(), sqrtPriceX96);
    }

    function addLiquidity(int24 tickLower, int24 tickUpper, uint256 liquidity) external onlyOwner {
        poolManager.unlock(abi.encode(MODE_ADD, abi.encode(tickLower, tickUpper, liquidity)));
    }

    /// @notice Swap exact `amountIn` through the pool (price mover for demos). Output goes to the owner.
    ///         The seeder must already hold the input token.
    function swapExactIn(bool zeroForOne, uint256 amountIn) external onlyOwner {
        poolManager.unlock(abi.encode(MODE_SWAP, abi.encode(zeroForOne, amountIn)));
    }

    function sweep(address token, address to) external onlyOwner {
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint8 mode, bytes memory inner) = abi.decode(data, (uint8, bytes));
        if (mode == MODE_ADD) {
            (int24 lower, int24 upper, uint256 liquidity) = abi.decode(inner, (int24, int24, uint256));
            (int256 delta,) = poolManager.modifyLiquidity(
                poolKey(), ModifyLiquidityParams(lower, upper, int256(liquidity), bytes32(0)), ""
            );
            _settleDelta(currency0, DeltaLib.amount0(delta));
            _settleDelta(currency1, DeltaLib.amount1(delta));
        } else {
            (bool zeroForOne, uint256 amountIn) = abi.decode(inner, (bool, uint256));
            int256 delta = poolManager.swap(
                poolKey(),
                SwapParams(zeroForOne, -int256(amountIn), zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE),
                ""
            );
            _settleDelta(currency0, DeltaLib.amount0(delta));
            _settleDelta(currency1, DeltaLib.amount1(delta));
        }
        return "";
    }

    /// @dev negative delta: we owe the pool, pay it; positive: the pool owes us, take it to the owner.
    function _settleDelta(address currency, int128 amount) internal {
        if (amount < 0) {
            poolManager.sync(currency);
            IERC20(currency).safeTransfer(address(poolManager), uint256(uint128(-amount)));
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, owner, uint256(uint128(amount)));
        }
    }
}
