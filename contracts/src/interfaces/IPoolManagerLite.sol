// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal subset of Uniswap v4's IPoolManager, copied from v4-core 1.0.2 and checked against the
///         DEPLOYED Monad testnet PoolManager (all selectors present). `Currency` and `IHooks` are plain
///         addresses on the wire and `BalanceDelta` is an int256 packing (amount0 << 128 | amount1), so these
///         declarations are ABI-identical to the originals.
struct PoolKey {
    address currency0; // lower address; address(0) is native
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManagerLite {
    function unlock(bytes calldata data) external returns (bytes memory);
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external
        returns (int256 callerDelta, int256 feesAccrued);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function take(address currency, address to, uint256 amount) external;
    function settle() external payable returns (uint256 paid);
}

interface IUnlockCallbackLite {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @dev BalanceDelta helpers (same bit layout as v4-core's BalanceDeltaLibrary).
library DeltaLib {
    function amount0(int256 d) internal pure returns (int128 a) {
        assembly ("memory-safe") {
            a := sar(128, d)
        }
    }

    function amount1(int256 d) internal pure returns (int128 a) {
        assembly ("memory-safe") {
            a := signextend(15, d)
        }
    }
}
