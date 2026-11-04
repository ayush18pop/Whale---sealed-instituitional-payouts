/**
 * One-time bootstrap of the private chain (PRD / BACKEND_SPEC section 3).
 *   pnpm bootstrap            first run (refuses if already bootstrapped and anvil has the contracts)
 *   pnpm bootstrap -- --force wipe the private chain state and redo (Hub block counters on Monad are kept)
 * Steps: start anvil (chain 7777, automine off, FIFO, gas price 0) -> deploy DomainToken + Treasury from
 * contracts/out -> demo accounts -> Treasury.setAuditor -> real Monad MainBridge deposit to the Treasury ->
 * the operator loop mints it and posts the result -> evm_snapshot ("opening").
 */
import { rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, encodeDeployData, getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, DATA_DIR, SYSTEM_RELAYER_ADDR, secrets } from "../src/config.js";
import { ensureAnvil, stopAnvil, portOpen, ANVIL_STATE } from "../src/anvil.js";
import { anvilRpc, domain, domainWallet, monad } from "../src/clients.js";
import { artifact, mineOne, snapshot } from "../src/privateChain.js";
import { store, paths, type DemoAccounts } from "../src/store.js";
import { Operator } from "../src/operator.js";
import { bus, type FeedEvent } from "../src/events.js";
import { NonceSender } from "../src/monadTx.js";
import { domainTokenAbi, mainBridgeAbi, testUSDCAbi, treasuryAbi } from "../src/abis.js";
import { ANVIL_PORT } from "../src/config.js";

const force = process.argv.includes("--force");
const OPENING_AMOUNT = 500_000_000_000n; // 500,000 tUSDC (6 decimals)
const say = (...a: unknown[]) => console.log("[bootstrap]", ...a);

function demoAccounts(): DemoAccounts {
  const existing = store.demo();
  if (existing) return existing;
  const mk = () => { const privateKey = generatePrivateKey(); return { address: privateKeyToAccount(privateKey).address, privateKey }; };
  const d: DemoAccounts = { finance: mk(), approvers: [mk(), mk(), mk()], auditor: mk(), payees: Array.from({ length: 50 }, mk) };
  store.saveDemo(d); // operator/data is git-ignored
  say("generated demo accounts ->", paths.demo);
  return d;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const had = store.chain();
  if (had && !force) {
    if (await portOpen(ANVIL_PORT)) {
      const code = await domain.getCode({ address: had.token });
      if (code && code !== "0x") { say("already bootstrapped; use --force to redo"); return; }
    }
  }
  if (force) {
    stopAnvil();
    await new Promise((r) => setTimeout(r, 500));
    for (const f of [paths.chain, paths.state, ANVIL_STATE]) if (existsSync(f)) rmSync(f);
    if (existsSync(paths.blocksDir)) for (const f of readdirSync(paths.blocksDir)) rmSync(join(paths.blocksDir, f));
  }
  say("anvil:", await ensureAnvil({ fresh: force || !had }));
  say("private chain id", await domain.getChainId());

  const demo = demoAccounts();
  // ---- deploy (finance account, gas price 0 so no balance is needed)
  const dtArt = artifact("DomainToken", "DomainToken"), trArt = artifact("Treasury", "Treasury");
  const fin = domainWallet(demo.finance.privateKey);
  const base = await domain.getTransactionCount({ address: demo.finance.address, blockTag: "pending" });
  const common = { gasPrice: 0n, type: "legacy", gas: 5_000_000n } as const;
  const tx1 = await fin.sendTransaction({ ...common, nonce: base, data: encodeDeployData({ abi: dtArt.abi, bytecode: dtArt.bytecode, args: [SYSTEM_RELAYER_ADDR, ADDR.tUSDC] }) } as any);
  const token = getAddress(await (async () => { await anvilRpc("evm_mine"); return (await domain.getTransactionReceipt({ hash: tx1 })).contractAddress!; })());
  const tx2 = await fin.sendTransaction({ ...common, nonce: base + 1, data: encodeDeployData({ abi: trArt.abi, bytecode: trArt.bytecode, args: [token, demo.finance.address, demo.approvers.map((a) => a.address), 2] }) } as any);
  const tx3Data = (t: Address) => encodeFunctionData({ abi: treasuryAbi, functionName: "setAuditor", args: [demo.auditor.address, true] });
  await mineOne();
  const treasury = getAddress((await domain.getTransactionReceipt({ hash: tx2 })).contractAddress!);
  await fin.sendTransaction({ ...common, gas: 200_000n, nonce: base + 2, to: treasury, data: tx3Data(treasury) } as any);
  await mineOne();
  if (!(await domain.readContract({ address: treasury, abi: treasuryAbi, functionName: "isAuditor", args: [demo.auditor.address] }))) throw new Error("setAuditor failed");
  say("deployed DomainToken", token, "Treasury", treasury);

  // ---- state + operator
  const headBefore = await monad.getBlockNumber();
  store.saveState({ cursorMonadBlock: headBefore, inflight: null, epoch: 1, claimed: {} });
  store.saveChain({ token, treasury, snapshotId: null, openingPrivateBlock: 0n, openingSupply: 0n, openingDepositMonadBlock: 0n, bootstrappedAt: new Date().toISOString() });
  const op = new Operator();
  await op.start();
  const posted = new Promise<Extract<FeedEvent, { type: "resultPosted" }>>((res, rej) => {
    const t = setTimeout(() => rej(new Error("operator did not post the opening result in 90 s")), 90_000);
    bus.on("feed", (e: FeedEvent) => { if (e.type === "resultPosted") { clearTimeout(t); res(e); } });
  });

  // ---- opening position: a REAL Monad deposit into the bridge, domain recipient = Treasury
  if (!(await monad.readContract({ address: ADDR.bridge, abi: mainBridgeAbi, functionName: "allowedToken", args: [ADDR.tUSDC] }))) throw new Error("tUSDC not allowed on the bridge");
  const dep = new NonceSender(secrets.deployer());
  const call = (to: Address, abi: any, fn: string, args: unknown[], gas: bigint) => dep.send({ to, data: encodeFunctionData({ abi, functionName: fn, args } as any), gas });
  await call(ADDR.tUSDC, testUSDCAbi, "mint", [dep.address, OPENING_AMOUNT], 120_000n);
  await call(ADDR.tUSDC, testUSDCAbi, "approve", [ADDR.bridge, OPENING_AMOUNT], 90_000n);
  const d = await call(ADDR.bridge, mainBridgeAbi, "deposit", [ADDR.tUSDC, OPENING_AMOUNT, treasury], 250_000n);
  const rc = await monad.waitForTransactionReceipt({ hash: d.hash, pollingInterval: 300 });
  if (rc.status !== "success") throw new Error("opening deposit reverted");
  say("opening deposit mined in Monad block", rc.blockNumber.toString(), d.hash);
  const res = await posted;
  say("operator minted + posted domain block", res.domainBlock, "tx", res.postTx);

  // ---- verify + snapshot
  const bal = await domain.readContract({ address: token, abi: domainTokenAbi, functionName: "balanceOf", args: [treasury], account: treasury });
  if (bal !== OPENING_AMOUNT) throw new Error(`treasury balance ${bal} != ${OPENING_AMOUNT}`);
  const snap = await snapshot();
  const info = store.chain()!;
  info.snapshotId = snap;
  info.openingPrivateBlock = await domain.getBlockNumber();
  info.openingSupply = await domain.readContract({ address: token, abi: domainTokenAbi, functionName: "totalSupply" });
  info.openingDepositMonadBlock = rc.blockNumber;
  store.saveChain(info);
  say("opening snapshot", snap, "at private block", info.openingPrivateBlock.toString(), "treasury balance", bal.toString());
  op.stop();
  process.exit(0);
}
main().catch((e) => { console.error("[bootstrap] FAILED:", e?.message ?? e); process.exit(1); });
