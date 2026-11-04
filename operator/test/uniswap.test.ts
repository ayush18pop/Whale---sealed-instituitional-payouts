import { describe, expect, it } from "vitest";
import { encodeErrorResult } from "viem";
import { Q96, deviationBps, priceString, quoteNumbers, restoreInput, simulateExactIn } from "../src/uniswap.js";
import { decodeRevert } from "../src/errors.js";
import { uniswapV4AdapterAbi } from "../src/abis.js";

const L = 4_000_000_000_000n; // pool liquidity
const FEE = 500n;

describe("quote math", () => {
  it("matches the measured fork swap: 100 in -> 99.947502 out at the opening price (+-2 units of rounding)", () => {
    const { out } = simulateExactIn(Q96, L, FEE, false, 100_000_000n);
    expect(Number(out)).toBeGreaterThanOrEqual(99_947_500);
    expect(Number(out)).toBeLessThanOrEqual(99_947_504);
    const rev = simulateExactIn(Q96, L, FEE, true, 100_000_000n);
    expect(Number(rev.out)).toBeGreaterThanOrEqual(99_947_500);
    expect(Number(rev.out)).toBeLessThanOrEqual(99_947_504);
  });
  it("expectedNet and minOut are net of the flat relayer fee", () => {
    const r = quoteNumbers(99_947_502n, 50_000n, 50);
    expect(r.expectedNet).toBe(99_897_502n);
    expect(r.suggestedMinOut).toBe((99_897_502n * 9950n) / 10_000n);
    // the bridge needs received >= minOut + fee; the quote gross must cover it
    expect(r.suggestedMinOut + 50_000n).toBeLessThanOrEqual(99_947_502n);
    expect(quoteNumbers(10_000n, 50_000n, 50)).toEqual({ expectedNet: 0n, suggestedMinOut: 0n });
  });
});

describe("price helpers", () => {
  it("1:1 and a moved price", () => {
    expect(priceString(Q96)).toBe("1.000000000000");
    expect(deviationBps(Q96)).toBe(0);
    const { sqrtNew } = simulateExactIn(Q96, L, FEE, false, 60_000_000_000n);
    expect(deviationBps(sqrtNew)).toBeGreaterThan(100);
  });
});

describe("restore amount", () => {
  for (const zeroForOne of [false, true]) {
    for (const move of [1_000_000n, 60_000_000_000n, 120_000_000_000n]) {
      it(`restores 1:1 after selling ${move} (${zeroForOne ? "token0" : "token1"})`, () => {
        const moved = simulateExactIn(Q96, L, FEE, zeroForOne, move).sqrtNew;
        const r = restoreInput(moved, L, FEE);
        expect(r.zeroForOne).toBe(!zeroForOne); // opposite token
        const back = simulateExactIn(moved, L, FEE, r.zeroForOne, r.amountIn).sqrtNew;
        expect(deviationBps(back)).toBeLessThan(0.01); // within 0.01 bp
        // the reverse leg is slightly smaller than the sale (price impact), never wildly different
        expect(r.amountIn).toBeGreaterThan((move * 95n) / 100n);
        expect(r.amountIn).toBeLessThanOrEqual(move);
      });
    }
  }
  it("is a no-op at 1:1", () => { expect(restoreInput(Q96, L, FEE).amountIn).toBe(0n); });
});

describe("error decoding", () => {
  for (const name of ["Slippage", "PartialFill", "NotBridge", "WrongPair"] as const) {
    it(`decodes adapter ${name}`, () => {
      const data = encodeErrorResult({ abi: uniswapV4AdapterAbi, errorName: name });
      expect(decodeRevert({ cause: { data } })?.name).toBe(name);
    });
  }
  it("returns UnknownError with raw data for foreign selectors and null without data", () => {
    expect(decodeRevert({ data: "0xdeadbeef" })?.name).toBe("UnknownError");
    expect(decodeRevert(new Error("x"))).toBeNull();
  });
});
