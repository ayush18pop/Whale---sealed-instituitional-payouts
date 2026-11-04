/**
 * End-to-end integration run against the live Monad testnet + a local private chain. ~20-25 result posts.
 *   pnpm e2e                         full run
 *   pnpm e2e -- --timing-runs=10     number of sequential timing samples (default 10)
 *   pnpm e2e -- --skip-crash         skip the two kill -9 restart tests
 *   pnpm e2e -- --skip-run-b         skip the post-reset second run
 * The e2e starts the service itself (so it can kill and restart it). Stop any running `pnpm start` first.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256, toHex, type Address, type Hex, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ADDR, DATA_DIR, MONAD_CHAIN_ID, OPERATOR_DIR, secrets, ANVIL_PORT } from "../src/config.js";
import { domain, monad, monadWallet } from "../src/clients.js";
import { domainTokenAbi, hubAbi, mainBridgeAbi, testUSDCAbi, treasuryAbi } from "../src/abis.js";
import { leafHash, verifyProof } from "../src/merkle.js";
import { portOpen } from "../src/anvil.js";
import { store } from "../src/store.js";
import { decryptTx } from "../src/crypto.js";
import { NonceSender } from "../src/monadTx.js";
import { api, callData, encryptTx, Feed, gasFor, signInner, sleep, stats, type Acct } from "./e2e-lib.js";

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}`));
const TIMING_RUNS = Number(arg("timing-runs")?.split("=")[1] ?? 10);
const SKIP_CRASH = !!arg("skip-crash"), SKIP_B = !!arg("skip-run-b");
const ADMIN = process.env.DEMO_ADMIN_TOKEN ?? "";

let fails = 0, passes = 0;
const check = (name: string, ok: boolean, detail = "") => { ok ? passes++ : fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`); };
const section = (s: string) => console.log(`\n=== ${s}`);
const ms = (n: number) => `${Math.round(n)} ms`;

// ------------------------------------------------------------------ service management
let server: ChildProcess | null = null;
function startServer(env: Record<string, string> = {}) {
  const log = join(DATA_DIR, "e2e-server.log");
  const p = spawn("node", ["--import", "tsx", "src/index.ts"], { cwd: OPERATOR_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => appendFileSync(log, d));
  p.stderr!.on("data", (d) => appendFileSync(log, d));
  server = p;
  return p;
}
async function waitReady(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await api("/api/status");
      if (r.status === 200 && r.body.operator.monadWsConnected && r.body.operator.status !== "starting") return r.body;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("service did not become ready");
}
const stopServer = async () => { if (server && server.exitCode === null) { server.kill("SIGTERM"); await sleep(500); } server = null; };
const hubLast = () => monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });

// ------------------------------------------------------------------ helpers
interface TxRun { id: Hex; status: string; receivedAt: number; clientStart: number; clientPosted: number; recvToIncl: number; inclToExec: number; recvToExec: number; execToPosted: number; recvToPosted: number; domainBlock: bigint; privateExecMs: number }
const allRuns: TxRun[] = [];
let feed: Feed;
let pubkey: Hex;
let demo: { finance: Acct; approvers: Acct[]; auditor: Acct; payees: Acct[]; treasury: Address; token: Address };

async function runTx(a: Acct, to: Address, data: Hex, opts: { gas?: bigint; label?: string; waitPosted?: boolean } = {}): Promise<TxRun> {
  const n = await api(`/api/nonce/${a.address}`, { as: a });
  if (n.status !== 200) throw new Error(`nonce fetch failed ${n.status} ${JSON.stringify(n.body)}`);
  const gas = opts.gas ?? (await gasFor(a, to, data));
  const raw = await signInner(a, to, data, gas, n.body.nonce);
  const ct = encryptTx(pubkey, raw);
  const clientStart = Date.now();
  const r = await api("/api/submit", { body: { ciphertext: ct, gasLimit: gas.toString() } });
  if (r.status !== 200) throw new Error(`submit failed ${r.status} ${JSON.stringify(r.body)}`);
  const id: Hex = r.body.id;
  const inc = await feed.waitFor((e) => e.type === "included" && e.id === id, 60_000, `included ${id}`);
  const dom = await feed.waitFor((e) => e.type === "domainBlock" && e.txs.some((t: any) => t.id === id), 60_000, `domainBlock ${id}`);
  const post = opts.waitPosted === false ? null : await feed.waitFor((e) => e.type === "resultPosted" && e.txs.some((t: any) => t.id === id), 90_000, `resultPosted ${id}`);
  const t = dom.txs.find((x: any) => x.id === id);
  const run: TxRun = {
    id, status: t.status, receivedAt: r.body.receivedAt, clientStart, clientPosted: post ? post._at : NaN,
    recvToIncl: inc.receivedToIncludedMs, inclToExec: t.includedToExecutedMs, recvToExec: t.receivedToExecutedMs,
    execToPosted: post ? post.executedToPostedMs : NaN, recvToPosted: post ? post.txs.find((x: any) => x.id === id).receivedToPostedMs : NaN,
    domainBlock: BigInt(dom.domainBlock), privateExecMs: dom.execMs,
  };
  allRuns.push(run);
  if (opts.label) console.log(`   ${opts.label}: status=${run.status} domainBlock=${run.domainBlock} recv->incl ${ms(run.recvToIncl)}, incl->exec ${ms(run.inclToExec)}, exec->posted ${ms(run.execToPosted)}, recv->posted ${ms(run.recvToPosted)} (privateExec ${run.privateExecMs} ms)`);
  return run;
}

const balanceAs = async (a: Acct, of: Address) => api(`/api/balance/${of}`, { as: a });
const tok = (a: Address) => monad.readContract({ address: ADDR.tUSDC, abi: testUSDCAbi, functionName: "balanceOf", args: [a] });
const tokUSDT = (a: Address) => monad.readContract({ address: ADDR.tUSDT, abi: testUSDCAbi, functionName: "balanceOf", args: [a] });

const BATCH_AMOUNTS = (): bigint[] => Array.from({ length: 50 }, (_, i) => (1000n + BigInt(i) * 10n) * 1_000_000n);

// ------------------------------------------------------------------ the batch flow (used for run A and run B)
async function batchFlow(tag: string) {
  const { finance, approvers, payees, treasury } = demo;
  const amounts = BATCH_AMOUNTS();
  const total = amounts.reduce((a, b) => a + b, 0n);
  const before = await api("/api/treasury", { as: finance });
  const openBal = BigInt(before.body.balance);
  const batchId = BigInt(before.body.batchCount) + 1n;

  // finance builds, signs, encrypts, submits a 50-payee batch
  const proposeData = callData(treasuryAbi, "propose", [payees.map((p) => p.address), amounts, keccak256(toHex(`memo-${tag}`))]);
  const gas = await gasFor(finance, treasury, proposeData);
  const raw = await signInner(finance, treasury, proposeData, gas, (await api(`/api/nonce/${finance.address}`, { as: finance })).body.nonce);
  const ct = encryptTx(pubkey, raw);
  check(`${tag}: ciphertext is opaque (len ${(ct.length - 2) / 2} B for ${(raw.length - 2) / 2} B plaintext)`, !payees.some((p) => ct.toLowerCase().includes(p.address.slice(2).toLowerCase())));
  const r = await api("/api/submit", { body: { ciphertext: ct, gasLimit: gas.toString() } });
  check(`${tag}: POST /api/submit accepted`, r.status === 200, JSON.stringify(r.body).slice(0, 120));
  const id: Hex = r.body.id;
  const inc = await feed.waitFor((e) => e.type === "included" && e.id === id, 60_000, "propose included");
  const dom = await feed.waitFor((e) => e.type === "domainBlock" && e.txs.some((t: any) => t.id === id), 60_000, "propose executed");
  const post = await feed.waitFor((e) => e.type === "resultPosted" && e.txs.some((t: any) => t.id === id), 90_000, "propose posted");
  const t = dom.txs.find((x: any) => x.id === id);
  allRuns.push({ id, status: t.status, receivedAt: r.body.receivedAt, clientStart: 0, clientPosted: post._at, recvToIncl: inc.receivedToIncludedMs, inclToExec: t.includedToExecutedMs, recvToExec: t.receivedToExecutedMs, execToPosted: post.executedToPostedMs, recvToPosted: post.txs.find((x: any) => x.id === id).receivedToPostedMs, domainBlock: BigInt(dom.domainBlock), privateExecMs: dom.execMs });
  check(`${tag}: propose executed on the private chain`, t.status === "executed", `exec ${dom.execMs} ms`);

  // FR2: what the public sees on Monad
  const tx = await monad.getTransaction({ hash: id });
  const input = tx.input.toLowerCase();
  const leaks = payees.filter((p) => input.includes(p.address.slice(2).toLowerCase())).length;
  check(`${tag} FR2: Hub tx input on Monad has no payee address (checked 50), courier=${tx.from.slice(0, 8)}...`, leaks === 0);
  const hubEv = await api("/api/public/hub-events?limit=5");
  check(`${tag}: /api/public/hub-events lists it`, hubEv.status === 200 && hubEv.body.submitted.some((s: any) => s.id === id));
  let decFails = false;
  try { decryptTx(generatePrivateKey(), ct); } catch { decFails = true; }
  check(`${tag}: ciphertext does not decrypt with another key`, decFails);

  // FR4: one approval does nothing; second executes
  const bView1 = await api(`/api/batches/${batchId}`, { as: finance });
  check(`${tag}: batch ${batchId} is Pending with ${payees.length} payees`, bView1.body.status === "Pending" && bView1.body.payeeCount === 50, JSON.stringify({ s: bView1.body.status, a: bView1.body.approvals }));
  await runTx(approvers[0], treasury, callData(treasuryAbi, "approve", [batchId]), { label: "approval 1" });
  const b1 = await api(`/api/batches/${batchId}`, { as: finance });
  const tr1 = await api("/api/treasury", { as: finance });
  const p0 = await balanceAs(payees[0], payees[0].address);
  check(`${tag} FR4: after ONE approval nothing moved`, b1.body.status === "Pending" && b1.body.approvals === 1 && BigInt(tr1.body.balance) === openBal && BigInt(p0.body.balance) === 0n, `status=${b1.body.status} approvals=${b1.body.approvals}`);
  const run2 = await runTx(approvers[1], treasury, callData(treasuryAbi, "approve", [batchId]), { gas: 6_000_000n, label: "approval 2 (executes 50 payments)" });
  const b2 = await api(`/api/batches/${batchId}`, { as: finance });
  const tr2 = await api("/api/treasury", { as: finance });
  check(`${tag} FR3/FR4: second approval executes the batch`, b2.body.status === "Executed" && BigInt(tr2.body.balance) === openBal - total, `treasury ${tr2.body.balance}`);
  let okAll = 0;
  for (let i = 0; i < 50; i++) { const b = await balanceAs(payees[i], payees[i].address); if (BigInt(b.body.balance) === amounts[i]) okAll++; }
  check(`${tag} FR3: all 50 payees read their own exact amount after ONE submission`, okAll === 50, `${okAll}/50`);
  console.log(`   private-chain execution of the 50-payee payout block (approval 2): ${run2.privateExecMs} ms (send + one mined block, operator clock)`);
  return { batchId, openBal, execMs: run2.privateExecMs, treasuryAfter: BigInt(tr2.body.balance), total, amounts };
}

// ------------------------------------------------------------------ main
async function main() {
  const chainInfo = store.chain();
  const d = store.demo();
  if (!chainInfo || !d) throw new Error("run `pnpm bootstrap` first");
  demo = { finance: d.finance, approvers: d.approvers, auditor: d.auditor, payees: d.payees, treasury: chainInfo.treasury, token: chainInfo.token };

  section("1. bootstrap state (FR1)");
  check("anvil private chain is up (id 7777)", (await portOpen(ANVIL_PORT)) && (await domain.getChainId()) === 7777);
  startServer();
  const status0 = await waitReady();
  feed = new Feed(); feed.start();
  pubkey = (await api("/api/crypto")).body.publicKey;
  const onchainKey = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "operatorEncryptionKey" });
  check("encryption key served by /api/crypto equals Hub.operatorEncryptionKey()", pubkey.toLowerCase() === onchainKey.toLowerCase());
  const rs = await api("/api/demo/reset", { method: "POST", headers: { "x-admin-token": ADMIN }, body: {} });
  check("reset to the opening snapshot works (start every run from the opening position)", rs.status === 200, rs.status === 200 ? `epoch ${rs.body.epoch}` : JSON.stringify(rs.body));
  const tr = await api("/api/treasury", { as: demo.finance });
  const escrow = await tok(ADDR.bridge);
  check("FR1: Treasury domain balance equals the opening Monad deposit", BigInt(tr.body.balance) === chainInfo.openingSupply, `${tr.body.balance} base units`);
  check("FR1: Monad escrow (MainBridge tUSDC balance) >= total minted in the domain", escrow >= chainInfo.openingSupply, `escrow ${escrow}`);
  void status0;

  section("2-4. run A: 50-payee batch, dual control, reads (FR2-FR6)");
  const A = await batchFlow("runA");
  const [pa, pb] = [demo.payees[0], demo.payees[1]];
  const own = await balanceAs(pa, pa.address);
  check("FR5: payee A reads own balance", own.status === 200 && BigInt(own.body.balance) === A.amounts[0]);
  const other = await balanceAs(pa, pb.address);
  check("FR5: payee A reading payee B -> 403 denied (from the contract)", other.status === 403 && other.body.error === "denied", JSON.stringify(other.body));
  const noauth = await api(`/api/balance/${pa.address}`);
  check("auth: no headers -> 401", noauth.status === 401);
  const stale = await api(`/api/balance/${pa.address}`, { headers: { "x-address": pa.address, "x-timestamp": String(Math.floor(Date.now() / 1000) - 300), "x-signature": await privateKeyToAccount(pa.privateKey).signMessage({ message: `whale-read:${Math.floor(Date.now() / 1000) - 300}` }) } });
  check("auth: stale timestamp -> 401", stale.status === 401);
  const wrong = await api(`/api/balance/${pa.address}`, { as: { address: pa.address, privateKey: pb.privateKey } });
  check("auth: signature by a different key -> 401", wrong.status === 401);
  const pay = await api(`/api/payments/${pa.address}`, { as: pa });
  check("payee reads own payments (batch id, amount, time)", pay.status === 200 && pay.body.payments.length === 1 && BigInt(pay.body.payments[0].amount) === A.amounts[0]);
  const payDenied = await api(`/api/payments/${pb.address}`, { as: pa });
  check("payee A reading payee B's payments -> 403", payDenied.status === 403);
  const stf = await api("/api/treasury", { as: pa });
  check("payee reading /api/treasury -> 403 (staff only)", stf.status === 403 && stf.body.error === "denied");
  const audB = await api(`/api/payments/${pb.address}`, { as: demo.auditor });
  check("auditor reads any payee's payments", audB.status === 200 && audB.body.payments.length === 1);
  const batches = await api("/api/batches", { as: demo.auditor });
  check("auditor lists batches", batches.status === 200 && batches.body.batches.length >= 1);
  // FR6: a contract calling balanceOf(victim) is denied. Code is injected with an eth_call state override (no deploy needed).
  
  const SNOOP = "0x000000000000000000000000000000000000dEaD" as Address;
  const code = "0x36601490038060146000376000600082600060003560601c5afa3d600060003e6027573d6000fd5b3d6000f3" as Hex;
  const payload = (`0x${demo.token.slice(2)}${callData(domainTokenAbi, "balanceOf", [pb.address]).slice(2)}`) as Hex;
  let snoopMsg = "";
  try { await domain.call({ account: pa.address, to: SNOOP, data: payload, stateOverride: [{ address: SNOOP, code }] }); snoopMsg = "NOT DENIED"; }
  catch (e: any) { snoopMsg = String(e?.cause?.data ?? e?.cause?.cause?.data ?? e?.details ?? e?.message).slice(0, 80); }
  const deniedSel = keccak256(toHex("Denied()")).slice(0, 10);
  const direct = await domain.call({ account: pb.address, to: demo.token, data: callData(domainTokenAbi, "balanceOf", [pb.address]) });
  check("FR6: contract-originated balanceOf(victim) is denied (revert Denied)", snoopMsg.includes(deniedSel.slice(2)) || /Denied/.test(snoopMsg), snoopMsg);
  check("FR6 control: the same call made directly by the owner succeeds", !!direct.data);

  section("5. results post in order with 2 signatures (FR7)");
  const last = await hubLast();
  const recs = store.allBlocks().filter((r) => r.domainBlock <= last).slice(-5);
  check("posted blocks are consecutive", recs.every((r, i) => i === 0 || r.domainBlock === recs[i - 1].domainBlock + 1n));
  check("every posted block carries exactly 2 operator signatures", recs.every((r) => r.signers.length === 2), `${recs.length} blocks inspected`);
  const lastR = store.block(last)!;
  const sim = (db: bigint) => monad.simulateContract({ address: ADDR.hub, abi: hubAbi, account: privateKeyToAccount(secrets.operators()[0]).address, functionName: "postResult", args: [db, lastR.monadBlock + 1n, lastR.stateRoot, lastR.msgRoot, []] });
  let rej1 = "", rej2 = "";
  try { await sim(last + 2n); } catch (e: any) { rej1 = e?.cause?.data?.errorName ?? e?.shortMessage ?? ""; }
  try { await sim(last); } catch (e: any) { rej2 = e?.cause?.data?.errorName ?? e?.shortMessage ?? ""; }
  check("FR7: skipping a block number is rejected (OutOfOrder)", /OutOfOrder/.test(rej1), rej1);
  check("FR7: re-posting an old block number is rejected (OutOfOrder)", /OutOfOrder/.test(rej2), rej2);

  section("6. auditor receipt (FR8)");
  const rc = await api(`/api/receipts/${pa.address}/${A.batchId}`, { as: demo.auditor });
  check("auditor fetches payee A's receipt", rc.status === 200, rc.status === 200 ? `domainBlock ${rc.body.domainBlock}, ${rc.body.proof.length} proof nodes` : JSON.stringify(rc.body));
  const onchain = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "results", args: [BigInt(rc.body.domainBlock)] });
  const lh = leafHash({ kind: 10, batchId: BigInt(rc.body.leaf.batchId), payee: rc.body.leaf.payee, amount: BigInt(rc.body.leaf.amount), salt: rc.body.leaf.salt });
  check("FR8: receipt proof verifies against the stateRoot stored on Monad (read from Hub.results)", verifyProof(onchain[0], lh, rc.body.proof) && rc.body.leaf.hash === lh);
  const tampered = [...rc.body.proof]; tampered[0] = tampered[0].replace(/.$/, (c: string) => (c === "0" ? "1" : "0"));
  const bad = await api("/api/receipts/verify", { body: { domainBlock: rc.body.domainBlock, leaf: rc.body.leaf, proof: tampered } });
  const good = await api("/api/receipts/verify", { body: { domainBlock: rc.body.domainBlock, leaf: rc.body.leaf, proof: rc.body.proof } });
  check("FR8: tampered proof fails, intact proof passes (POST /api/receipts/verify)", bad.body.valid === false && good.body.valid === true);
  const wrongAmt = await api("/api/receipts/verify", { body: { domainBlock: rc.body.domainBlock, leaf: { ...rc.body.leaf, amount: "1" }, proof: rc.body.proof } });
  check("FR8: a receipt with an altered amount fails", wrongAmt.body.valid === false);
  const rcDenied = await api(`/api/receipts/${pa.address}/${A.batchId}`, { as: pb });
  check("receipt for payee A requested by payee B -> 403", rcDenied.status === 403);
  const rcSelf = await api(`/api/receipts/${pa.address}/${A.batchId}`, { as: pa });
  check("payee A fetches own receipt", rcSelf.status === 200);

  section("7. withdraw to tUSDC, claim once (FR9)");
  const wAmt = A.amounts[0];
  await runTx(pa, demo.token, callData(domainTokenAbi, "requestWithdrawal", [wAmt]), { label: "payee A requestWithdrawal" });
  const wl = await api(`/api/withdrawals/${pa.address}`, { as: pa });
  const w0 = wl.body.withdrawals?.[0];
  check("withdrawal is claimable with leaf fields, salt and proof", wl.status === 200 && w0?.status === "claimable" && w0.kind === 1 && w0.salt && Array.isArray(w0.proof), w0?.status);
  const wDenied = await api(`/api/withdrawals/${pa.address}`, { as: pb });
  check("withdrawals of A requested by B -> 403", wDenied.status === 403);
  const balBefore = await tok(pa.address);
  const c1 = await api("/api/claim", { body: { address: pa.address, nonce: w0.nonce } });
  check("claim paid on Monad", c1.status === 200 && c1.body.kind === "claim", JSON.stringify(c1.body).slice(0, 200));
  const balAfter = await tok(pa.address);
  check("FR9: payee received exactly the withdrawn amount in tUSDC", balAfter - balBefore === wAmt, `${balAfter - balBefore}`);
  const c2 = await api("/api/claim", { body: { address: pa.address, nonce: w0.nonce } });
  check("FR9: a second claim of the same leaf is rejected (AlreadyClaimed)", c2.status === 409 && c2.body.revert?.name === "AlreadyClaimed", JSON.stringify(c2.body).slice(0, 200));
  check("withdrawal status is now claimed", (await api(`/api/withdrawals/${pa.address}`, { as: pa })).body.withdrawals[0].status === "claimed");

  section("8. withdraw to tUSDT through claimSwap; slippage; fallback claimAsInput (FR12-FR14)");
  const sAmt = A.amounts[1];
  const q = await api("/api/quote", { body: { tokenIn: ADDR.tUSDC, tokenOut: ADDR.tUSDT, amountIn: sAmt.toString(), slippageBps: 50 } });
  check("quote returns simulated:true with suggested minOut", q.status === 200 && q.body.simulated === true, JSON.stringify(q.body).slice(0, 220));
  const minOut = BigInt(q.body.suggestedMinOut), maxFee = BigInt(q.body.suggestedMaxFee);
  await runTx(pb, demo.token, callData(domainTokenAbi, "requestSwapWithdrawal", [sAmt, ADDR.tUSDT, minOut, maxFee]), { label: "payee B requestSwapWithdrawal" });
  const wb = (await api(`/api/withdrawals/${pb.address}`, { as: pb })).body.withdrawals[0];
  const usdtBefore = await tokUSDT(pb.address);
  const cs = await api("/api/claim", { body: { address: pb.address, nonce: wb.nonce } });
  const usdtAfter = await tokUSDT(pb.address);
  check("FR12: claimSwap pays tUSDT >= minOut", cs.status === 200 && cs.body.kind === "claimSwap" && usdtAfter - usdtBefore >= minOut, `received ${usdtAfter - usdtBefore}, minOut ${minOut}`);
  check("FR12: relayer fee <= maxFee", cs.status === 200 && BigInt(cs.body.feePaid) <= maxFee, `fee ${cs.body?.feePaid} maxFee ${maxFee}`);
  // C: slippage then fallback
  const pc = demo.payees[2];
  const cAmt = A.amounts[2];
  const qc = (await api("/api/quote", { body: { tokenIn: ADDR.tUSDC, tokenOut: ADDR.tUSDT, amountIn: cAmt.toString(), slippageBps: 50 } })).body;
  await runTx(pc, demo.token, callData(domainTokenAbi, "requestSwapWithdrawal", [cAmt, ADDR.tUSDT, BigInt(qc.suggestedMinOut), BigInt(qc.suggestedMaxFee)]), { label: "payee C requestSwapWithdrawal" });
  const wc = (await api(`/api/withdrawals/${pc.address}`, { as: pc })).body.withdrawals[0];
  const mr = await api("/api/demo/mock-rate", { headers: { "x-admin-token": ADMIN }, body: { rate: "900000000000000000" } });
  check("demo/mock-rate moves the MockSwap rate to 0.9", mr.status === 200, mr.body.tx);
  const cf = await api("/api/claim", { body: { address: pc.address, nonce: wc.nonce } });
  check("FR13: claimSwap with the moved rate fails with Slippage (surfaced revert)", cf.status === 409 && cf.body.revert?.name === "Slippage", JSON.stringify(cf.body).slice(0, 200));
  // fallback: payee sends claimAsInput from their own Monad account (needs MON for gas: fund from the deployer)
  const fund = await fetchFund(pc.address);
  const fb = wc.claimAsInput.args;
  const argsW = { payee: fb.w.payee, tokenIn: fb.w.tokenIn, tokenOut: fb.w.tokenOut, amountIn: BigInt(fb.w.amountIn), minOut: BigInt(fb.w.minOut), maxFee: BigInt(fb.w.maxFee), nonce: BigInt(fb.w.nonce) };
  const tUSDCbefore = await tok(pc.address);
  let fbOk = false, fbDetail = "", stage = "estimate";
  try {
    const cdata = encodeFunctionData({ abi: hubAbi, functionName: "claimAsInput", args: [BigInt(fb.domainBlock), argsW, fb.salt, fb.proof] });
    const gas = await monad.estimateGas({ account: pc.address, to: ADDR.hub, data: cdata });
    stage = "send";
    const sent = await new NonceSender(pc.privateKey).send({ to: ADDR.hub, data: cdata, gas: (gas * 12n) / 10n });
    stage = "receipt";
    const rcp = await monad.waitForTransactionReceipt({ hash: sent.hash, pollingInterval: 400 });
    fbOk = rcp.status === "success";
    fbDetail = sent.hash;
  } catch (e: any) { fbDetail = `${stage}: ${String(e.shortMessage ?? e.message).slice(0, 160)} | ${String(e.details ?? "").slice(0, 120)}`; }
  const tUSDCafter = await tok(pc.address);
  check("FR14: fallback claimAsInput (payee-sent) succeeds after the failed swap, paying tokenIn", fbOk && tUSDCafter - tUSDCbefore === cAmt, `${fbDetail} funded=${fund}`);
  await api("/api/demo/mock-rate", { headers: { "x-admin-token": ADMIN }, body: { rate: "1000000000000000000" } });
  const again = await api("/api/claim", { body: { address: pc.address, nonce: wc.nonce } });
  check("after the fallback, the swap claim is rejected (AlreadyClaimed)", again.status === 409 && again.body.revert?.name === "AlreadyClaimed", JSON.stringify(again.body).slice(0, 160));

  if (!SKIP_B) {
    section("9. reset restores the opening position; a second full run behaves identically (FR10)");
    const r = await api("/api/demo/reset", { method: "POST", headers: { "x-admin-token": ADMIN }, body: {} });
    check("POST /api/demo/reset", r.status === 200, JSON.stringify(r.body.actions));
    const t2 = await api("/api/treasury", { as: demo.finance });
    check("FR10: Treasury balance and batch counter are back at the opening position", BigInt(t2.body.balance) === chainInfo.openingSupply && t2.body.batchCount === "0");
    const p0 = await balanceAs(pa, pa.address);
    check("FR10: payee balances are zero again", BigInt(p0.body.balance) === 0n);
    check("FR10: Hub block counter kept (not reset)", (await hubLast()) >= last);
    const B = await batchFlow("runB");
    check("FR10: run B equals run A (same batch id, same treasury balance, same payee amounts)", B.batchId === A.batchId && B.treasuryAfter === A.treasuryAfter);
    const wl2 = await api(`/api/withdrawals/${pa.address}`, { as: pa });
    check("old-run withdrawals are not served after reset", wl2.body.withdrawals.length === 0);
    await runTx(pa, demo.token, callData(domainTokenAbi, "requestWithdrawal", [B.amounts[0]]), { label: "run B payee A requestWithdrawal" });
    const w2 = (await api(`/api/withdrawals/${pa.address}`, { as: pa })).body.withdrawals[0];
    const c = await api("/api/claim", { body: { address: pa.address, nonce: w2.nonce } });
    check("run B: claim paid again after reset (escrow restored)", c.status === 200, JSON.stringify(c.body).slice(0, 160));
  }

  section(`10. timing: ${TIMING_RUNS} sequential single-transaction submissions (setPayoutPreference)`);
  const timed: TxRun[] = [];
  for (let i = 0; i < TIMING_RUNS; i++) {
    const p = demo.payees[10 + i];
    timed.push(await runTx(p, demo.token, callData(domainTokenAbi, "setPayoutPreference", [ADDR.tUSDT]), { label: `timing ${i + 1}/${TIMING_RUNS}` }));
  }
  report(timed);

  if (!SKIP_CRASH) await crashTests();

  section("summary");
  console.log(`${passes} passed, ${fails} failed; on-chain result posts this run: ${allRuns.length > 0 ? "see Hub" : "0"}`);
  const finalLast = await hubLast();
  console.log(`Hub.lastDomainBlock = ${finalLast}`);
  feed.stop();
  await stopServer();
  process.exit(fails ? 1 : 0);
}

async function fetchFund(to: Address) {
  // top up the payee's Monad balance for the one fallback claim (payee-only function): 0.03 MON from the deployer
  const dep = monadWallet(secrets.deployer());
  const bal = await monad.getBalance({ address: to });
  if (bal >= 30_000_000_000_000_000n) return "already funded";
  const h = await dep.sendTransaction({ to, value: 30_000_000_000_000_000n, gas: 21_000n, maxFeePerGas: 125_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n });
  await monad.waitForTransactionReceipt({ hash: h, pollingInterval: 400 });
  return "0.03 MON";
}

function report(timed: TxRun[]) {
  const col = (xs: TxRun[], f: (r: TxRun) => number) => stats(xs.map(f).filter((x) => Number.isFinite(x)));
  const row = (name: string, s: ReturnType<typeof stats>) => console.log(`   ${name.padEnd(44)} n=${s.n}  median ${ms(s.median)}  p95 ${ms(s.p95)}  min ${ms(s.min)}  max ${ms(s.max)}`);
  console.log("\nTIMING REPORT (operator clock; 'included' = operator saw the Monad log on its WebSocket subscription)");
  console.log(`  dedicated sequential runs (n=${timed.length}):`);
  row("API receipt -> included on Monad", col(timed, (r) => r.recvToIncl));
  row("included -> executed on private chain", col(timed, (r) => r.inclToExec));
  row("submission -> domain executed", col(timed, (r) => r.recvToExec));
  row("executed -> result posted (Monad confirmed)", col(timed, (r) => r.execToPosted));
  row("submission -> result posted", col(timed, (r) => r.recvToPosted));
  row("client-observed: POST /submit -> resultPosted WS", col(timed, (r) => r.clientPosted - r.clientStart));
  console.log(`  all ${allRuns.length} submissions in this e2e run (mixed sizes, incl. 50-payee batches):`);
  row("submission -> domain executed", col(allRuns, (r) => r.recvToExec));
  row("submission -> result posted", col(allRuns, (r) => r.recvToPosted));
  const batchExec = allRuns.filter((r) => r.privateExecMs > 100).map((r) => r.privateExecMs);
  console.log(`  private-chain execution (send + mine) per block, all runs: ${JSON.stringify(stats(allRuns.map((r) => r.privateExecMs)))} ms`);
  void batchExec;
}

// ------------------------------------------------------------------ crash tests
async function crashTests() {
  section("restart-safety: kill -9 mid-flow (deposit crash after mine; submission crash after sign)");
  await stopServer();
  await sleep(500);
  // --- crash 1: after the private block is mined, before the record is saved/posted
  startServer({ WHALE_CRASH_AT: "afterMine" });
  await waitReady();
  const exited1 = new Promise<string>((res) => server!.on("exit", (_c, sig) => res(String(sig))));
  const lastBefore = await hubLast();
  const headBefore = await domain.getBlockNumber();
  const target = demo.payees[30];
  const balPre = BigInt((await api(`/api/balance/${target.address}`, { as: target })).body.balance);
  const amt = 1_234_000_000n;
  const dep = new NonceSender(secrets.deployer());
  const call = (to: Address, abi: any, fn: string, args: unknown[], gas: bigint) => dep.send({ to, data: encodeFunctionData({ abi, functionName: fn, args } as any), gas });
  await call(ADDR.tUSDC, testUSDCAbi, "mint", [dep.address, amt], 120_000n);
  await call(ADDR.tUSDC, testUSDCAbi, "approve", [ADDR.bridge, amt], 90_000n);
  const dtx = await call(ADDR.bridge, mainBridgeAbi, "deposit", [ADDR.tUSDC, amt, target.address], 250_000n);
  const sig = await Promise.race([exited1, sleep(60_000).then(() => "TIMEOUT")]);
  check("crash 1: the service died with SIGKILL after mining (fault injection)", sig === "SIGKILL", sig);
  const st = store.state();
  const headMid = await domain.getBlockNumber();
  check("crash 1: private block was mined but nothing was posted; in-flight marker persisted", st.inflight !== null && headMid === headBefore + 1n && (await hubLast()) === lastBefore, `inflight=${!!st.inflight} head ${headBefore}->${headMid}`);
  feed.events.length = 0;
  startServer();
  await waitReady();
  await feed.waitFor((e) => e.type === "resultPosted", 90_000, "post after restart");
  const headAfter = await domain.getBlockNumber();
  const bal = await api(`/api/balance/${target.address}`, { as: target });
  check("crash 1: after restart the block was posted exactly once (Hub +1)", (await hubLast()) === lastBefore + 1n);
  check("crash 1: deposit minted exactly once (no double mint, no extra private block)", BigInt(bal.body.balance) - balPre === amt && headAfter === headMid, `balance ${bal.body.balance}, private head ${headMid}->${headAfter}`);
  void dtx;
  // --- crash 2: after signing, before the Monad post is sent
  await stopServer();
  await sleep(500);
  startServer({ WHALE_CRASH_AT: "afterSign" });
  await waitReady();
  const exited2 = new Promise<string>((res) => server!.on("exit", (_c, sg) => res(String(sg))));
  const last2 = await hubLast();
  const head2 = await domain.getBlockNumber();
  const p = demo.payees[31];
  const n = (await api(`/api/nonce/${p.address}`, { as: p })).body.nonce;
  const data = callData(domainTokenAbi, "setPayoutPreference", [ADDR.tUSDT]);
  const raw = await signInner(p, demo.token, data, 100_000n, n);
  const r = await api("/api/submit", { body: { ciphertext: encryptTx(pubkey, raw), gasLimit: "100000" } });
  const sig2 = await Promise.race([exited2, sleep(60_000).then(() => "TIMEOUT")]);
  check("crash 2: the service died with SIGKILL after signing, before the post was sent", sig2 === "SIGKILL" && r.status === 200, sig2);
  check("crash 2: private block mined, result not posted", (await domain.getBlockNumber()) === head2 + 1n && (await hubLast()) === last2);
  feed.events.length = 0;
  startServer();
  await waitReady();
  await feed.waitFor((e) => e.type === "resultPosted", 90_000, "post after restart 2");
  check("crash 2: after restart the block was posted exactly once (Hub +1) and nothing re-executed", (await hubLast()) === last2 + 1n && (await domain.getBlockNumber()) === head2 + 1n);
}

main().catch(async (e) => { console.error("E2E ERROR:", e); try { await stopServer(); } catch { /* */ } process.exit(2); });
