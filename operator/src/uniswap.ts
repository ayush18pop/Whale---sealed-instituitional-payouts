import { type Address } from "viem";
import { ADDR, UNI } from "./config.js";
import { monad } from "./clients.js";
import { mainBridgeAbi } from "./abis.js";

/** Minimal ABIs, from v4-periphery 1.0.3 (IV4Quoter, IStateView); selectors confirmed present in the deployed bytecode. */
export const v4QuoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: [
      { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" } ] },
    { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" } ] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }],
}] as const;
export const stateViewAbi = [
  { type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" }, { name: "protocolFee", type: "uint24" }, { name: "lpFee", type: "uint24" }] },
  { type: "function", name: "getLiquidity", stateMutability: "view", inputs: [{ name: "poolId", type: "bytes32" }], outputs: [{ name: "liquidity", type: "uint128" }] },
] as const;

export const Q96 = 2n ** 96n;
const FEE_DEN = 1_000_000n;
const PRICE_SCALE = 10n ** 12n;

// ------------------------------------------------------------------ pure math

/** Net payout and the suggested minOut. MainBridge requires minOut to be received AFTER the flat relayer fee. */
export function quoteNumbers(gross: bigint, relayerFee: bigint, slippageBps: number) {
  const expectedNet = gross > relayerFee ? gross - relayerFee : 0n;
  const suggestedMinOut = (expectedNet * BigInt(10_000 - slippageBps)) / 10_000n;
  return { expectedNet, suggestedMinOut };
}

/** Price of currency0 in currency1 (token1/token0, both 6 decimals) scaled by 1e12 (integer). */
export function priceScaled(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * PRICE_SCALE) / (Q96 * Q96);
}
/** Decimal string with 12 fraction digits, e.g. "1.000000000000". */
export function priceString(sqrtPriceX96: bigint): string {
  const p = priceScaled(sqrtPriceX96);
  return `${p / PRICE_SCALE}.${(p % PRICE_SCALE).toString().padStart(12, "0")}`;
}
/** Deviation of the price from 1:1 in basis points (absolute, as a float). */
export function deviationBps(sqrtPriceX96: bigint): number {
  const p = Number(priceScaled(sqrtPriceX96)) / 1e12;
  return Math.abs(p - 1) * 1e4;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Single-range (no tick crossing) exact-input swap, as the pool computes it: fee taken from the input, then
 * concentrated-liquidity deltas. Used to size the restore swap and in tests; the chain is the source of truth.
 */
export function simulateExactIn(sqrtP: bigint, L: bigint, feePips: bigint, zeroForOne: boolean, grossIn: bigint) {
  const net = (grossIn * (FEE_DEN - feePips)) / FEE_DEN;
  if (zeroForOne) {
    // token0 in: 1/sqrtP' = 1/sqrtP + net/L  =>  sqrtP' = L*Q96*sqrtP / (L*Q96 + net*sqrtP)
    const sqrtNew = (L * Q96 * sqrtP) / (L * Q96 + net * sqrtP);
    const out = (L * (sqrtP - sqrtNew)) / Q96; // token1 out
    return { sqrtNew, out };
  }
  const sqrtNew = sqrtP + (net * Q96) / L;
  const out = (L * Q96 * (sqrtNew - sqrtP)) / (sqrtP * sqrtNew); // token0 out
  return { sqrtNew, out };
}

/**
 * Input (gross, i.e. including the pool fee) that moves the pool from `sqrtP` back to `target`.
 * sqrtP below target (token0 got cheaper): sell token1 (zeroForOne=false); above: sell token0.
 */
export function restoreInput(sqrtP: bigint, L: bigint, feePips: bigint, target: bigint = Q96): { zeroForOne: boolean; amountIn: bigint } {
  if (sqrtP === target || L === 0n) return { zeroForOne: false, amountIn: 0n };
  let net: bigint, zeroForOne: boolean;
  if (sqrtP < target) {
    zeroForOne = false;
    net = ceilDiv(L * (target - sqrtP), Q96); // dy = L * (sqrtT - sqrtP)
  } else {
    zeroForOne = true;
    net = ceilDiv(L * Q96 * (sqrtP - target), sqrtP * target); // dx = L * (1/sqrtT - 1/sqrtP)
  }
  return { zeroForOne, amountIn: ceilDiv(net * FEE_DEN, FEE_DEN - feePips) };
}

// ------------------------------------------------------------------ chain reads

export interface PoolState { sqrtPriceX96: bigint; tick: number; liquidity: bigint }
export async function readPool(): Promise<PoolState> {
  const [s0, liquidity] = await Promise.all([
    monad.readContract({ address: UNI.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [UNI.poolId] }),
    monad.readContract({ address: UNI.stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [UNI.poolId] }),
  ]);
  return { sqrtPriceX96: s0[0], tick: s0[1], liquidity };
}
export const poolView = (p: PoolState) => ({ sqrtPriceX96: p.sqrtPriceX96, tick: p.tick, price: priceString(p.sqrtPriceX96), liquidity: p.liquidity });

/** Real-pool quote: V4Quoter.quoteExactInputSingle by eth_call (the function is not `view`, so simulate it). */
export async function quoteUniswap(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint }> {
  const zeroForOne = tokenIn.toLowerCase() === UNI.key.currency0.toLowerCase() && tokenOut.toLowerCase() === UNI.key.currency1.toLowerCase();
  const { result } = await monad.simulateContract({
    address: UNI.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle",
    args: [{ poolKey: UNI.key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
  });
  return { amountOut: result[0], gasEstimate: result[1] };
}

export const bridgeAdapter = () => monad.readContract({ address: ADDR.bridge, abi: mainBridgeAbi, functionName: "swapAdapter" });
