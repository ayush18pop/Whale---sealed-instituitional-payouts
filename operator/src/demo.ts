import { encodeFunctionData, type Address } from "viem";
import { ADDR, IS_UNI, UNI, secrets } from "./config.js";
import { monad } from "./clients.js";
import { mockSwapAbi, poolSeederAbi, testUSDCAbi } from "./abis.js";
import { deviationBps, poolView, readPool, restoreInput } from "./uniswap.js";
import { NonceSender } from "./monadTx.js";
import { dropPool, revert, snapshot } from "./privateChain.js";
import { store } from "./store.js";
import { emitFeed } from "./events.js";
import type { Operator } from "./operator.js";
import { ApiError } from "./relayer.js";

const RATE_ONE = 10n ** 18n;
let deployerSender: NonceSender | null = null;
const deployer = () => (deployerSender ??= new NonceSender(secrets.deployer()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function confirm(hash: `0x${string}`) {
  for (let i = 0; i < 60; i++) {
    const rc = await monad.getTransactionReceipt({ hash }).catch(() => null);
    if (rc) { if (rc.status !== "success") throw new ApiError(502, "tx_reverted", `Monad tx ${hash} reverted`); return rc; }
    await sleep(500);
  }
  throw new ApiError(504, "timeout", `Monad tx ${hash} not confirmed in 30 s`);
}

/** MockSwap.setRate(tokenIn, tokenOut, rate) as the deployer. */
export async function setMockRate(tokenIn: Address, tokenOut: Address, rate: bigint) {
  const data = encodeFunctionData({ abi: mockSwapAbi, functionName: "setRate", args: [tokenIn, tokenOut, rate] });
  const s = await deployer().send({ to: ADDR.swap, data, gas: 90_000n });
  const rc = await confirm(s.hash);
  return { tx: s.hash, monadBlock: rc.blockNumber.toString() };
}

/**
 * Reset to the opening position: revert the private chain to the opening snapshot (Hub block counters are NOT
 * touched; they live on Monad), restore the mock rate to 1.0, top up the bridge escrow if earlier claims drained
 * it below the opening supply, bump the epoch so old-run proofs and receipts are no longer served.
 */
export async function resetDemo(op: Operator) {
  const chain = store.chain();
  if (!chain?.snapshotId) throw new ApiError(409, "no_snapshot", "no opening snapshot; run pnpm bootstrap");
  await op.pause();
  try {
    await dropPool();
    const ok = await revert(chain.snapshotId);
    if (!ok) throw new ApiError(409, "snapshot_lost", "anvil no longer has the opening snapshot (anvil was restarted); run pnpm bootstrap --force");
    chain.snapshotId = await snapshot(); // a revert consumes the snapshot id
    store.saveChain(chain);
    const st = store.state();
    st.epoch += 1;
    st.inflight = null;
    store.saveState(st);
    op.setChain(chain);

    const actions: Record<string, string> = {};
    if (IS_UNI) {
      const rp = await restorePrice().catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
      actions.poolPrice = "error" in rp ? `restore failed: ${rp.error}` : rp.skipped ? "already ~1:1" : `restored (${rp.txs.length} swap)`;
    } else {
      const r = await monad.readContract({ address: ADDR.swap, abi: mockSwapAbi, functionName: "rate", args: [ADDR.tUSDC, ADDR.tUSDT] });
      if (r !== RATE_ONE) actions.mockRate = (await setMockRate(ADDR.tUSDC, ADDR.tUSDT, RATE_ONE)).tx;
    }
    const bal = await monad.readContract({ address: ADDR.tUSDC, abi: testUSDCAbi, functionName: "balanceOf", args: [ADDR.bridge] });
    if (bal < chain.openingSupply) {
      const data = encodeFunctionData({ abi: testUSDCAbi, functionName: "mint", args: [ADDR.bridge, chain.openingSupply - bal] });
      const s = await deployer().send({ to: ADDR.tUSDC, data, gas: 100_000n });
      await confirm(s.hash);
      actions.escrowTopUp = `${chain.openingSupply - bal}`;
    }
    emitFeed({ type: "reset", epoch: st.epoch });
    return { epoch: st.epoch, snapshotId: chain.snapshotId, actions };
  } finally {
    op.resume();
  }
}

// ------------------------------------------------------------------ Uniswap v4 price mover (PoolSeeder, owner = deployer)

export const MAX_MOVE = 150_000n * 10n ** 6n; // the pool's liquidity range is about +-10% (~195k of each token)
const RESTORE_TOLERANCE_BPS = 1;
const SEEDER_BUFFER = 1_000_000n * 10n ** 6n;
let moveLock: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = moveLock.then(f, f); moveLock = p.catch(() => undefined); return p; };

/** The seeder must hold the input token; the open-mint tokens let the deployer top it up. */
async function ensureSeederBalance(token: Address, need: bigint): Promise<string | null> {
  const bal = await monad.readContract({ address: token, abi: testUSDCAbi, functionName: "balanceOf", args: [ADDR.seeder] });
  if (bal >= need) return null;
  const mintAmt = need - bal + SEEDER_BUFFER;
  const data = encodeFunctionData({ abi: testUSDCAbi, functionName: "mint", args: [ADDR.seeder, mintAmt] });
  const s = await deployer().send({ to: token, data, gas: 100_000n });
  await confirm(s.hash);
  return s.hash;
}

async function seederSwap(zeroForOne: boolean, amountIn: bigint) {
  const token = zeroForOne ? UNI.key.currency0 : UNI.key.currency1;
  const mintTx = await ensureSeederBalance(token, amountIn);
  const data = encodeFunctionData({ abi: poolSeederAbi, functionName: "swapExactIn", args: [zeroForOne, amountIn] });
  const est = await monad.estimateGas({ account: ADDR.deployer, to: ADDR.seeder, data }).catch((e) => {
    throw new ApiError(409, "move_failed", `PoolSeeder.swapExactIn would revert: ${String((e as Error).message).slice(0, 200)}`);
  });
  const s = await deployer().send({ to: ADDR.seeder, data, gas: (est * 13n) / 10n });
  const rc = await confirm(s.hash);
  return { tx: s.hash, monadBlock: rc.blockNumber.toString(), mintTx };
}

/** direction "down": sell tUSDC into the pool, so the tUSDC->tUSDT rate (the claim-and-swap direction) gets worse. "up": sell tUSDT. */
export function movePrice(direction: "down" | "up", amountIn: bigint) {
  return serial(async () => {
    if (amountIn <= 0n || amountIn > MAX_MOVE) throw new ApiError(400, "bad_request", `amount must be 1..${MAX_MOVE} base units (150,000 tokens): larger moves leave the pool's liquidity range`);
    const before = await readPool();
    const zeroForOne = direction === "up"; // currency0 = tUSDT, currency1 = tUSDC
    const sold = zeroForOne ? UNI.key.currency0 : UNI.key.currency1;
    const r = await seederSwap(zeroForOne, amountIn);
    const after = await readPool();
    return { direction, sold, amountIn: amountIn.toString(), ...r, before: poolView(before), after: poolView(after) };
  });
}

/** Bring the pool back to 1:1: size the opposite swap from sqrtPriceX96 and liquidity, execute, read back, once more if needed. */
export function restorePrice() {
  return serial(async () => {
    const before = await readPool();
    let cur = before;
    const txs: string[] = [];
    for (let i = 0; i < 2; i++) {
      if (deviationBps(cur.sqrtPriceX96) <= RESTORE_TOLERANCE_BPS / 10 && i === 0) break; // already within 0.1 bp
      if (i > 0 && deviationBps(cur.sqrtPriceX96) <= RESTORE_TOLERANCE_BPS) break;
      const { zeroForOne, amountIn } = restoreInput(cur.sqrtPriceX96, cur.liquidity, BigInt(UNI.key.fee), UNI.initialSqrtPriceX96);
      if (amountIn < 1000n) break; // under 0.001 token: nothing worth moving
      const r = await seederSwap(zeroForOne, amountIn);
      txs.push(r.tx);
      cur = await readPool();
    }
    const dev = deviationBps(cur.sqrtPriceX96);
    return { skipped: txs.length === 0, txs, before: poolView(before), after: poolView(cur), deviationBps: dev, withinOneBp: dev <= RESTORE_TOLERANCE_BPS };
  });
}
