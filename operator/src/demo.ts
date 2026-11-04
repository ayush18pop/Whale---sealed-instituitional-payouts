import { encodeFunctionData, type Address } from "viem";
import { ADDR, secrets } from "./config.js";
import { monad } from "./clients.js";
import { mockSwapAbi, testUSDCAbi } from "./abis.js";
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
    const r = await monad.readContract({ address: ADDR.swap, abi: mockSwapAbi, functionName: "rate", args: [ADDR.tUSDC, ADDR.tUSDT] });
    if (r !== RATE_ONE) actions.mockRate = (await setMockRate(ADDR.tUSDC, ADDR.tUSDT, RATE_ONE)).tx;
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
