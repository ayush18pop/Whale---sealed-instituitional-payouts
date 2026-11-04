import { EventEmitter } from "node:events";
import {
  encodeFunctionData, getAddress, keccak256, parseEventLogs, parseTransaction, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptTx } from "./crypto.js";
import { ADDR, CRASH_AT, GAS, MONAD_CHAIN_ID, SYSTEM_RELAYER_ADDR, secrets, DOMAIN_CHAIN_ID } from "./config.js";
import { domain, domainWallet, monad } from "./clients.js";
import { domainTokenAbi, hubAbi, treasuryAbi } from "./abis.js";
import { bus, emitFeed, receivedAtById } from "./events.js";
import { MonadWatcher, fetchBlockEvents, fetchRange, type MonadEvents } from "./monadWatch.js";
import { NonceSender } from "./monadTx.js";
import { buildTree, leafHash, randomSalt, type LedgerLeaf, type MsgLeaf } from "./merkle.js";
import { resultDigest, signDigest, sortSignatures } from "./digest.js";
import { dropPool, mineOne, poolStatus } from "./privateChain.js";
import { store, type BlockRecord, type ChainInfo, type DepositOutcome, type SubmissionOutcome } from "./store.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[operator]", ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Hash = Hex;
type Leafed<T> = T & { hash: Hex };

export class Operator extends EventEmitter {
  readonly watcher = new MonadWatcher();
  status: "starting" | "idle" | "processing" | "paused" | "error" = "starting";
  lastError: string | null = null;
  private chain!: ChainInfo;
  private poster!: NonceSender;
  private sysNonce: number | null = null;
  private queue: { block: bigint; triggerAt: number }[] = [];
  private known = new Set<string>(); // queued or done in this process
  private working = false;
  private paused = false;
  private waiters = new Map<string, (v: { tx: Hex; block: bigint }) => void>();
  private blockTasks = new Map<string, { seen: number; fetched: number; running: boolean; at: number }>();
  private idleResolvers: (() => void)[] = [];
  lastResult: { domainBlock: bigint; monadBlock: bigint; stateRoot: Hex; msgRoot: Hex; postTx: Hex } | null = null;

  constructor() {
    super();
  }

  // ------------------------------------------------------------------ lifecycle

  async start(opts: { subscribe?: boolean } = {}) {
    const c = store.chain();
    if (!c) throw new Error("private chain not bootstrapped (run pnpm bootstrap)");
    this.chain = c;
    this.poster = new NonceSender(secrets.operators()[0]);
    await this.poster.warm();
    setInterval(() => void this.poster.warmGas(), 15_000).unref();
    await this.resumeInflight();
    if (opts.subscribe === false) { this.status = "idle"; return; }
    this.watcher.on("logs", (b: bigint) => this.onLogBlock(b));
    this.watcher.on("open", () => this.catchUp().catch((e) => this.fail(e)));
    this.watcher.start();
    this.status = "idle";
  }
  stop() { this.watcher.stop(); }

  private fail(e: unknown) {
    this.lastError = String((e as Error)?.stack ?? e).slice(0, 2000);
    this.status = "error";
    log("ERROR", this.lastError);
  }

  /** Resolves when the queue is drained and nothing is processing. */
  idle(): Promise<void> {
    if (!this.working && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  // ------------------------------------------------------------------ catch-up and triggers

  async catchUp() {
    const state = store.state();
    const head = await monad.getBlockNumber();
    if (state.cursorMonadBlock === null) {
      state.cursorMonadBlock = head; // first start without bootstrap cursor: begin at the current head
      store.saveState(state);
      log("no cursor; starting at Monad head", head.toString());
      return;
    }
    const from = state.cursorMonadBlock + 1n;
    if (from > head) return;
    log(`catch-up ${from}..${head}`);
    const evs = await fetchRange(from, head);
    for (const e of evs) this.handleBlockEvents(e, Date.now());
  }

  private onLogBlock(b: bigint) {
    const k = b.toString();
    const t = this.blockTasks.get(k) ?? { seen: 0, fetched: 0, running: false, at: Date.now() };
    t.seen++;
    this.blockTasks.set(k, t);
    if (!t.running) void this.runBlockTask(b, k);
    if (this.blockTasks.size > 200) for (const key of [...this.blockTasks.keys()].slice(0, 100)) this.blockTasks.delete(key);
  }
  private async runBlockTask(b: bigint, k: string) {
    const t = this.blockTasks.get(k)!;
    t.running = true;
    try {
      while (t.fetched < t.seen) {
        const want = t.seen;
        const ev = await fetchBlockEvents(b, want);
        t.fetched = Math.max(want, ev.submitted.length + ev.deposits.length + ev.other.length);
        this.handleBlockEvents(ev, t.at);
        if (t.fetched < t.seen) await sleep(50);
      }
    } catch (e) {
      log("block fetch failed", b.toString(), String(e).slice(0, 200));
      this.blockTasks.delete(k);
      this.catchUp().catch(() => undefined);
    } finally { t.running = false; }
  }

  private handled = new Set<string>();
  /** Route one Monad block's events: feed, waiters, and the operator queue. */
  private handleBlockEvents(ev: MonadEvents, includedAt: number) {
    const key = ev.blockNumber.toString();
    const first = !this.handled.has(key + ":" + ev.submitted.length + ":" + ev.deposits.length + ":" + ev.other.length);
    if (!first) return;
    this.handled.add(key + ":" + ev.submitted.length + ":" + ev.deposits.length + ":" + ev.other.length);
    if (this.handled.size > 500) this.handled.clear();

    for (const o of ev.other) {
      if (o.name === "ResultPosted") {
        const w = this.waiters.get(String(o.args.domainBlock));
        if (w) w({ tx: o.txHash, block: ev.blockNumber });
      } else if (o.name === "Claimed" || o.name === "ClaimedSwap" || o.name === "ClaimedAsInput") {
        emitFeed({
          type: "claimed", kind: o.name === "Claimed" ? "claim" : o.name === "ClaimedSwap" ? "claimSwap" : "claimAsInput",
          domainBlock: String(o.args.domainBlock), payee: o.args.payee, tx: o.txHash, at: Date.now(),
          token: o.args.token ?? o.args.tokenIn, amount: String(o.args.amount ?? o.args.amountIn), nonce: String(o.args.nonce),
        });
      }
    }
    for (const s of ev.submitted) {
      const r = receivedAtById.get(s.id);
      emitFeed({ type: "included", id: s.id, monadBlock: ev.blockNumber.toString(), includedAt, receivedToIncludedMs: r ? includedAt - r : null });
    }
    if (ev.submitted.length + ev.deposits.length > 0) {
      const cursor = store.state().cursorMonadBlock;
      if (cursor !== null && ev.blockNumber <= cursor) return; // already processed
      if (this.known.has(key)) return;
      this.known.add(key);
      this.queue.push({ block: ev.blockNumber, triggerAt: includedAt });
      this.queue.sort((a, b) => (a.block < b.block ? -1 : 1));
      void this.work();
    }
  }

  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length && !this.paused) {
        const item = this.queue.shift()!;
        this.status = "processing";
        try {
          await this.processMonadBlock(item.block, item.triggerAt);
          this.status = "idle";
        } catch (e) {
          this.fail(e);
          this.queue.unshift(item); // retry later after manual restart; keeps ordering
          this.known.delete(item.block.toString());
          this.queue = [];
          break;
        }
      }
    } finally {
      this.working = false;
      if (!this.queue.length && this.status !== "error") this.status = this.paused ? "paused" : "idle";
      const rs = this.idleResolvers.splice(0);
      for (const r of rs) r();
    }
  }

  // ------------------------------------------------------------------ one Monad block -> one domain block

  /** Public so bootstrap and tests can drive a block deterministically. */
  async processMonadBlock(M: bigint, triggerAt = Date.now(), pre?: MonadEvents) {
    const startedAt = Date.now();
    const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
    const D = lastD + 1n;
    let rec = store.block(D);
    if (rec && rec.monadBlock !== M) {
      // Block D already executed for another Monad block: the queue must be processed in order, so
      // this can only mean M was handled before D (a later retry). Skip if M already posted.
      throw new Error(`domain block ${D} already derived from Monad block ${rec.monadBlock}, got ${M}`);
    }
    if (!rec) {
      const ev = pre ?? (await fetchBlockEvents(M, 1));
      rec = await this.execute(D, M, ev, triggerAt, startedAt);
    }
    await this.signAndPost(rec);
    const st = store.state();
    st.cursorMonadBlock = M;
    store.saveState(st);
  }

  /** Crash recovery: finish a block whose execution started but whose record was not saved. */
  private async resumeInflight() {
    const st = store.state();
    if (!st.inflight) return;
    const { domainBlock: D, monadBlock: M, startPrivateBlock } = st.inflight;
    const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
    log(`resuming in-flight domain block ${D} (Monad ${M}, private start ${startPrivateBlock}); Hub last=${lastD}`);
    if (store.block(D)) { st.inflight = null; store.saveState(st); return; }
    if (lastD >= D) throw new Error(`Hub already at domain block ${lastD} but no local record for ${D}: cannot rebuild proofs`);
    const head = await domain.getBlockNumber();
    const ev = await fetchBlockEvents(M, 1);
    if (head === startPrivateBlock + 1n) {
      log("private block already mined: rebuilding the record from chain state");
      await this.finalize(D, M, ev, head, Date.now(), Date.now(), Date.now());
    } else if (head === startPrivateBlock) {
      log("private block not mined yet: dropping the pool and re-executing");
      await this.execute(D, M, ev, Date.now(), Date.now(), true);
    } else throw new Error(`unexpected private head ${head} for in-flight start ${startPrivateBlock}`);
    // the queue picks it up: processMonadBlock will find the record and post it
    this.known.add(M.toString());
    this.queue.push({ block: M, triggerAt: Date.now() });
    void this.work();
  }

  private async execute(D: bigint, M: bigint, ev: MonadEvents, includedAt: number, startedAt: number, resumed = false): Promise<BlockRecord> {
    const startPrivate = await domain.getBlockNumber();
    const st = store.state();
    st.inflight = { domainBlock: D, monadBlock: M, startPrivateBlock: startPrivate };
    store.saveState(st);
    await dropPool(); // a re-run after a crash must not inherit half-submitted txs
    const execStart = Date.now();

    // (a) deposits first
    const sysWallet = domainWallet(secrets.systemRelayer());
    if (this.sysNonce === null || resumed) this.sysNonce = await domain.getTransactionCount({ address: SYSTEM_RELAYER_ADDR, blockTag: "pending" });
    for (const d of ev.deposits) {
      if (d.token.toLowerCase() !== ADDR.tUSDC.toLowerCase()) continue;
      if (await domain.readContract({ address: this.chain.token, abi: domainTokenAbi, functionName: "depositProcessed", args: [d.depositId] })) continue;
      await sysWallet.sendTransaction({
        to: this.chain.token, data: encodeFunctionData({ abi: domainTokenAbi, functionName: "mintDeposit", args: [d.depositId, d.domainRecipient, d.amount] }),
        gas: 200_000n, nonce: this.sysNonce++, gasPrice: 0n, type: "legacy",
      } as any);
    }
    // (b) submissions in log order
    for (const s of ev.submitted) {
      try {
        const raw = decryptTx(secrets.encPrivate(), s.ciphertext);
        const tx = parseTransaction(raw);
        if (tx.chainId !== DOMAIN_CHAIN_ID) throw new Error("wrong chain id");
        const to = tx.to?.toLowerCase();
        if (to !== this.chain.token.toLowerCase() && to !== this.chain.treasury.toLowerCase()) throw new Error("destination not allowed");
        await domain.sendRawTransaction({ serializedTransaction: raw });
      } catch { /* skip: reason is derived from receipts in finalize() */ }
    }
    // (c) mine ONE block
    const privateBlock = await mineOne();
    const executedAt = Date.now();
    if (CRASH_AT === "afterMine") { log("FAULT INJECTION: crashing after mine"); process.kill(process.pid, "SIGKILL"); }
    return this.finalize(D, M, ev, privateBlock, includedAt, execStart, executedAt, startedAt);
  }

  /** Derive outcomes + trees from the mined private block; persists the record BEFORE anything is signed. */
  private async finalize(D: bigint, M: bigint, ev: MonadEvents, privateBlock: bigint, includedAt: number, execStart: number, executedAt: number, startedAt = execStart): Promise<BlockRecord> {
    const pool = await poolStatus().catch(() => null);
    if (pool && (Number(BigInt(pool.pending)) > 0)) { log("WARN: pending private txs left after the block (did not fit); dropping"); await dropPool(); }
    const blk = await domain.getBlock({ blockNumber: privateBlock });
    const logs = await domain.getLogs({ address: [this.chain.token, this.chain.treasury], fromBlock: privateBlock, toBlock: privateBlock });
    const tokenLogs = parseEventLogs({ abi: domainTokenAbi, logs: logs.filter((l) => l.address.toLowerCase() === this.chain.token.toLowerCase()) });
    const trLogs = parseEventLogs({ abi: treasuryAbi, logs: logs.filter((l) => l.address.toLowerCase() === this.chain.treasury.toLowerCase()) });
    const ordered = [...tokenLogs, ...trLogs].sort((a, b) => Number(a.transactionIndex! - b.transactionIndex!) || a.logIndex! - b.logIndex!);

    const msg: Leafed<MsgLeaf>[] = [];
    const led: Leafed<LedgerLeaf>[] = [];
    for (const l of ordered) {
      if (l.eventName === "WithdrawalRequested") {
        const leaf: MsgLeaf = { kind: 1, payee: l.args.payee, token: l.args.token, amount: l.args.amount, nonce: l.args.nonce, salt: randomSalt() };
        msg.push({ ...leaf, hash: leafHash(leaf) });
      } else if (l.eventName === "SwapWithdrawalRequested") {
        const a = l.args;
        const leaf: MsgLeaf = { kind: 2, payee: a.payee, tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, minOut: a.minOut, maxFee: a.maxFee, nonce: a.nonce, salt: randomSalt() };
        msg.push({ ...leaf, hash: leafHash(leaf) });
      } else if (l.eventName === "Paid") {
        const leaf: LedgerLeaf = { kind: 10, batchId: l.args.batchId, payee: l.args.payee, amount: l.args.amount, salt: randomSalt() };
        led.push({ ...leaf, hash: leafHash(leaf) });
      }
    }
    const blockLeaf: LedgerLeaf = { kind: 11, privateBlockHash: blk.hash, salt: randomSalt() };
    led.push({ ...blockLeaf, hash: leafHash(blockLeaf) });
    const msgRoot = buildTree(msg.map((m) => m.hash)).root;
    const stateRoot = buildTree(led.map((m) => m.hash)).root;

    // outcomes
    const submissions: SubmissionOutcome[] = [];
    for (const s of ev.submitted) {
      const o: SubmissionOutcome = { id: s.id, courier: s.courier, gasLimit: s.gasLimit, monadBlock: M, logIndex: s.logIndex, status: "skipped", includedAt, receivedAt: receivedAtById.get(s.id) };
      try {
        const raw = decryptTx(secrets.encPrivate(), s.ciphertext);
        o.innerHash = keccak256(raw);
        const rc = await domain.getTransactionReceipt({ hash: o.innerHash }).catch(() => null);
        if (rc && rc.blockNumber === privateBlock) o.status = rc.status === "success" ? "executed" : "reverted";
        else o.reason = "not executed (rejected by the private chain or not allowed)";
      } catch { o.reason = "decryption failed"; }
      submissions.push(o);
    }
    const deposits: DepositOutcome[] = [];
    for (const d of ev.deposits) {
      if (d.token.toLowerCase() !== ADDR.tUSDC.toLowerCase()) { deposits.push({ depositId: d.depositId, to: d.domainRecipient, amount: d.amount, skipped: "unsupported token" }); continue; }
      const done = await domain.readContract({ address: this.chain.token, abi: domainTokenAbi, functionName: "depositProcessed", args: [d.depositId] });
      deposits.push({ depositId: d.depositId, to: d.domainRecipient, amount: d.amount, skipped: done ? undefined : "mint failed" });
    }

    const rec: BlockRecord = {
      epoch: store.state().epoch, domainBlock: D, monadBlock: M, privateBlock, privateBlockHash: blk.hash,
      privateBlockTimestamp: Number(blk.timestamp), stateRoot, msgRoot, msgLeaves: msg, ledgerLeaves: led,
      deposits, submissions, signers: [],
      timing: { startedAt, executedAt, execMs: executedAt - execStart },
    };
    store.saveBlock(rec);
    const st = store.state();
    st.inflight = null;
    store.saveState(st);
    log(`domain block ${D} (Monad ${M}, private ${privateBlock}): ${submissions.length} tx, ${deposits.length} deposits, ${msg.length} withdrawals, ${led.length - 1} payments, exec ${rec.timing.execMs} ms`);
    emitFeed({
      type: "domainBlock", domainBlock: D.toString(), monadBlock: M.toString(), privateBlock: privateBlock.toString(), privateBlockHash: blk.hash,
      execMs: rec.timing.execMs, executedAt,
      txs: submissions.map((s) => ({
        id: s.id, status: s.status, reason: s.reason,
        receivedToIncludedMs: s.receivedAt ? s.includedAt - s.receivedAt : null,
        includedToExecutedMs: executedAt - s.includedAt,
        receivedToExecutedMs: s.receivedAt ? executedAt - s.receivedAt : null,
      })),
      deposits: deposits.map((d) => ({ depositId: d.depositId.toString(), to: d.to, amount: d.amount.toString(), skipped: d.skipped })),
      withdrawals: msg.length, payments: led.length - 1,
    });
    return rec;
  }

  // ------------------------------------------------------------------ attest and post

  private async signAndPost(rec: BlockRecord) {
    const D = rec.domainBlock;
    const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
    if (lastD >= D) { await this.markPosted(rec, rec.postTx, undefined); return; } // already posted (restart)

    // A previously sent post tx must be waited on, not re-sent (a duplicate would revert and burn fees).
    let postTx = rec.postTx;
    let sentAt = rec.timing.postSentAt ?? 0;
    if (postTx) {
      const known = await monad.getTransaction({ hash: postTx }).catch(() => null);
      if (!known) postTx = undefined;
    }
    if (!postTx) {
      const digest = resultDigest({ hub: ADDR.hub, monadChainId: MONAD_CHAIN_ID, domainBlock: D, monadBlock: rec.monadBlock, stateRoot: rec.stateRoot, msgRoot: rec.msgRoot });
      const threshold = Number(await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "threshold" }));
      const sigs: { signer: Address; signature: Hex }[] = [];
      for (const pk of secrets.operators()) { // OPERATOR_PK_1, _2, fall back to _3
        if (sigs.length >= threshold) break;
        try { sigs.push(await signDigest(pk, digest)); } catch { /* try the next key */ }
      }
      if (sigs.length < threshold) throw new Error("could not collect enough operator signatures");
      rec.signers = sigs.map((s) => s.signer);
      rec.timing.signedAt = Date.now();
      if (CRASH_AT === "afterSign") { log("FAULT INJECTION: crashing after sign"); process.kill(process.pid, "SIGKILL"); }
      const data = encodeFunctionData({ abi: hubAbi, functionName: "postResult", args: [D, rec.monadBlock, rec.stateRoot, rec.msgRoot, sortSignatures(sigs)] });
      const waiter = new Promise<{ tx: Hex; block: bigint }>((res) => this.waiters.set(D.toString(), res));
      const sent = await this.poster.send({ to: ADDR.hub, data, gas: GAS.postResult });
      postTx = sent.hash;
      sentAt = sent.sentAt;
      rec.postTx = postTx;
      rec.timing.postSentAt = sentAt;
      store.saveBlock(rec);
      this.lastPostWait = waiter;
    }
    await this.waitPosted(D, postTx);
    await this.markPosted(rec, postTx, this.lastPostBlock);
  }
  private lastPostWait?: Promise<{ tx: Hex; block: bigint }>;
  private lastPostBlock?: bigint;

  private async waitPosted(D: bigint, postTx: Hex) {
    this.lastPostBlock = undefined;
    const waiter = this.lastPostWait ?? new Promise<{ tx: Hex; block: bigint }>((res) => this.waiters.set(D.toString(), res));
    this.lastPostWait = undefined;
    const deadline = Date.now() + 40_000;
    for (;;) {
      const r = await Promise.race([waiter, sleep(3000).then(() => null)]);
      if (r) { this.lastPostBlock = r.block; break; }
      // fallback if the WS delivery was missed: look at the chain
      const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
      if (lastD >= D) break;
      const rc = await monad.getTransactionReceipt({ hash: postTx }).catch(() => null);
      if (rc && rc.status === "reverted") throw new Error(`postResult ${postTx} reverted on Monad`);
      if (Date.now() > deadline) throw new Error(`postResult ${postTx} not confirmed after 40 s`);
    }
    this.waiters.delete(D.toString());
  }

  private async markPosted(rec: BlockRecord, postTx: Hex | undefined, postBlock: bigint | undefined) {
    const now = Date.now();
    rec.timing.postedAt ??= now;
    if (postBlock) rec.postedMonadBlock = postBlock;
    store.saveBlock(rec);
    this.lastResult = { domainBlock: rec.domainBlock, monadBlock: rec.monadBlock, stateRoot: rec.stateRoot, msgRoot: rec.msgRoot, postTx: postTx ?? rec.postTx! };
    const postedAt = rec.timing.postedAt;
    emitFeed({
      type: "resultPosted", domainBlock: rec.domainBlock.toString(), monadBlock: rec.monadBlock.toString(),
      stateRoot: rec.stateRoot, msgRoot: rec.msgRoot, postTx: this.lastResult.postTx, signers: rec.signers,
      postedAt, executedToPostedMs: postedAt - rec.timing.executedAt,
      txs: rec.submissions.map((s) => ({ id: s.id, receivedToPostedMs: s.receivedAt ? postedAt - s.receivedAt : null, includedToPostedMs: postedAt - s.includedAt })),
    });
    log(`posted domain block ${rec.domainBlock}: ${this.lastResult.postTx}`);
  }

  // ------------------------------------------------------------------ control (reset support)

  async pause() { this.paused = true; await this.idle(); this.status = "paused"; }
  resume() { this.paused = false; this.status = "idle"; void this.work(); }
  setChain(c: ChainInfo) { this.chain = c; this.sysNonce = null; }
}
void getAddress; void bus;
