import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { ADDR, API_HOST, API_PORT, CORS_ORIGIN, DEMO_ADMIN_TOKEN, DEMO_MODE, DOMAIN_CHAIN_ID, ENC_PUBLIC_KEY, EXPLORER, MONAD_CHAIN_ID, SWAP_INFO, SYSTEM_RELAYER_ADDR } from "./config.js";
import { domain, monad } from "./clients.js";
import { domainTokenAbi, hubAbi, mainBridgeAbi, mockSwapAbi, treasuryAbi } from "./abis.js";
import { AuthError, verifyAuth, AUTH_WINDOW_S } from "./auth.js";
import { CRYPTO_SPEC } from "./crypto.js";
import { bus, type FeedEvent } from "./events.js";
import { ApiError, Relayer } from "./relayer.js";
import { Operator } from "./operator.js";
import { store, type BlockRecord } from "./store.js";
import { buildTree, verifyProof, type MsgLeaf } from "./merkle.js";
import { resetDemo, setMockRate } from "./demo.js";
import { fetchRange } from "./monadWatch.js";

const STATUS = ["None", "Pending", "Executed", "Cancelled"] as const;
const str = (v: unknown): any => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

function isDeniedErr(e: unknown): boolean {
  for (let cur: any = e, i = 0; cur && i < 8; cur = cur.cause, i++) {
    if (cur.data?.errorName === "Denied" || cur.errorName === "Denied") return true;
  }
  return false;
}
/** Run a private-chain read as `from`; the contract's own check decides. Denied -> 403. */
async function asUser<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (isDeniedErr(e)) throw new ApiError(403, "denied", "the contract denied this read for your address");
    throw e;
  }
}
const addrParam = (v: string): Address => {
  if (!isAddress(v, { strict: false })) throw new ApiError(400, "bad_request", "invalid address");
  return getAddress(v);
};

export async function startApi(op: Operator, relayer: Relayer) {
  const app = new Hono();
  const chain = () => store.chain()!;
  const feedRing: FeedEvent[] = [];
  bus.on("feed", (e: FeedEvent) => { feedRing.push(e); if (feedRing.length > 100) feedRing.shift(); });

  app.use("*", cors({ origin: CORS_ORIGIN.split(","), allowHeaders: ["content-type", "x-address", "x-timestamp", "x-signature", "authorization", "x-admin-token"], allowMethods: ["GET", "POST", "OPTIONS"], maxAge: 600 }));
  app.onError((e, c) => {
    if (e instanceof ApiError) return c.json({ error: e.code, message: e.message, ...(e.extra ?? {}) }, e.status as any);
    if (e instanceof AuthError) return c.json({ error: "unauthorized", message: e.message }, 401);
    console.error("[api] unhandled", String((e as Error)?.stack ?? e).slice(0, 600));
    return c.json({ error: "internal", message: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not_found", message: "no such route" }, 404));

  const auth = (c: Context) => verifyAuth({ address: c.req.header("x-address"), timestamp: c.req.header("x-timestamp"), signature: c.req.header("x-signature") });
  const admin = (c: Context) => {
    if (!DEMO_ADMIN_TOKEN) throw new ApiError(503, "admin_disabled", "DEMO_ADMIN_TOKEN is not configured");
    const t = c.req.header("x-admin-token") ?? c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (t !== DEMO_ADMIN_TOKEN) throw new ApiError(401, "unauthorized", "bad admin token");
  };
  const read = <T = any>(R: Address, address: Address, abi: any, fn: string, args: unknown[] = []): Promise<T> =>
    asUser(domain.readContract({ address, abi, functionName: fn, args, account: R } as any)) as Promise<T>;
  const pub = <T = any>(address: Address, abi: any, fn: string, args: unknown[] = []): Promise<T> =>
    domain.readContract({ address, abi, functionName: fn, args } as any) as Promise<T>;

  // ---------------------------------------------------------------- public
  let statusCache: { at: number; v: unknown } | null = null;
  app.get("/api/status", async (c) => {
    if (statusCache && Date.now() - statusCache.at < 1500) return c.json(statusCache.v);
    const ch = chain();
    const [lastD, lastM, relFee, rateIO, rateOI, headP, monadHead] = await Promise.all([
      monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" }),
      monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastMonadBlock" }),
      monad.readContract({ address: ADDR.bridge, abi: mainBridgeAbi, functionName: "relayerFee" }),
      monad.readContract({ address: ADDR.swap, abi: mockSwapAbi, functionName: "rate", args: [ADDR.tUSDC, ADDR.tUSDT] }),
      monad.readContract({ address: ADDR.swap, abi: mockSwapAbi, functionName: "rate", args: [ADDR.tUSDT, ADDR.tUSDC] }),
      domain.getBlockNumber(),
      op.watcher.head ? Promise.resolve(op.watcher.head) : monad.getBlockNumber(),
    ]);
    const v = str({
      chainIds: { monad: MONAD_CHAIN_ID, domain: DOMAIN_CHAIN_ID },
      monad: { head: monadHead, lastDomainBlock: lastD, lastMonadBlock: lastM },
      domain: { privateHead: headP, lastDomainBlock: lastD },
      lastResult: op.lastResult ?? (lastD > 0n ? (() => { const r = store.block(lastD); return r ? { domainBlock: r.domainBlock, monadBlock: r.monadBlock, stateRoot: r.stateRoot, msgRoot: r.msgRoot, postTx: r.postTx } : null; })() : null),
      contracts: { hub: ADDR.hub, bridge: ADDR.bridge, mockSwap: ADDR.swap, tUSDC: ADDR.tUSDC, tUSDT: ADDR.tUSDT, domainToken: ch.token, treasury: ch.treasury, systemRelayer: SYSTEM_RELAYER_ADDR },
      tokens: { tUSDC: { address: ADDR.tUSDC, decimals: 6 }, tUSDT: { address: ADDR.tUSDT, decimals: 6 }, pUSDC: { address: ch.token, decimals: 6 } },
      swap: { adapter: SWAP_INFO.adapter, simulated: true, rates: { "tUSDC>tUSDT": rateIO, "tUSDT>tUSDC": rateOI }, rateScale: "1e18", poolFeeBps: SWAP_INFO.poolFeeBps, relayerFee: relFee },
      operator: { status: op.status, lastError: op.lastError, monadWsConnected: op.watcher.connected, cursorMonadBlock: store.state().cursorMonadBlock },
      relayers: relayer.addresses,
      epoch: store.state().epoch,
      demoMode: DEMO_MODE,
      explorer: EXPLORER,
      serverTime: Date.now(),
    });
    statusCache = { at: Date.now(), v };
    return c.json(v);
  });

  app.get("/api/crypto", (c) => c.json({ publicKey: ENC_PUBLIC_KEY, publishedOn: { hub: ADDR.hub, fn: "operatorEncryptionKey()" }, scheme: CRYPTO_SPEC, domainChainId: DOMAIN_CHAIN_ID, maxCiphertextBytes: 65536, maxGasLimit: 30_000_000 }));

  app.post("/api/submit", bodyLimit({ maxSize: 400_000, onError: (c) => c.json({ error: "bad_request", message: "body too large" }, 413) }), async (c) => {
    const receivedAt = Date.now();
    const body = await c.req.json().catch(() => null);
    const ct = body?.ciphertext;
    if (typeof ct !== "string" || !isHex(ct) || ct.length < 4 || ct.length % 2 !== 0) throw new ApiError(400, "bad_request", "ciphertext must be 0x-prefixed even-length hex");
    if ((ct.length - 2) / 2 > 65536) throw new ApiError(400, "ciphertext_too_large", "ciphertext exceeds 65536 bytes");
    let gl: bigint;
    try { gl = BigInt(body.gasLimit); } catch { throw new ApiError(400, "bad_request", "gasLimit must be an integer"); }
    if (gl <= 0n || gl > 30_000_000n) throw new ApiError(400, "bad_gas_limit", "gasLimit must be in 1..30000000");
    const r = await relayer.submit(ct as Hex, gl, receivedAt);
    return c.json(str(r));
  });

  // recent Hub events as the public sees them
  const pubRing: { type: "Submitted"; id: Hex; courier: Address; gasLimit: bigint; ciphertextBytes: number; ciphertextPreview: Hex; monadBlock: bigint; explorer: string }[] = [];
  const pubResults: { type: "ResultPosted"; domainBlock: bigint; monadBlock: bigint; stateRoot: Hex; msgRoot: Hex; tx: Hex; explorer: string }[] = [];
  let backfilled = false;
  const seenPub = new Set<string>();
  const addSubmitted = (e: { id: Hex; courier: Address; gasLimit: bigint; ciphertext: Hex; blockNumber: bigint; logIndex: number }) => {
    const k = `${e.id}:${e.logIndex}`;
    if (seenPub.has(k)) return;
    seenPub.add(k);
    pubRing.push({ type: "Submitted", id: e.id, courier: e.courier, gasLimit: e.gasLimit, ciphertextBytes: (e.ciphertext.length - 2) / 2, ciphertextPreview: (e.ciphertext.slice(0, 66) + "...") as Hex, monadBlock: e.blockNumber, explorer: `${EXPLORER}/tx/${e.id}` });
    pubRing.sort((a, b) => (a.monadBlock < b.monadBlock ? -1 : a.monadBlock > b.monadBlock ? 1 : 0));
    while (pubRing.length > 300) pubRing.shift();
  };
  const addResult = (r: BlockRecord) => {
    if (!r.postTx || pubResults.some((x) => x.domainBlock === r.domainBlock)) return;
    pubResults.push({ type: "ResultPosted", domainBlock: r.domainBlock, monadBlock: r.monadBlock, stateRoot: r.stateRoot, msgRoot: r.msgRoot, tx: r.postTx, explorer: `${EXPLORER}/tx/${r.postTx}` });
    while (pubResults.length > 100) pubResults.shift();
  };
  op.on("monadEvents", (ev: any) => { for (const s of ev.submitted) addSubmitted({ ...s, blockNumber: ev.blockNumber }); });
  app.get("/api/public/hub-events", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 200);
    if (!backfilled) { // one-time look-back of ~1800 blocks (about 10 min) so the panel is not empty after a restart
      backfilled = true;
      const head = await monad.getBlockNumber();
      for (const ev of await fetchRange(head - 1800n, head)) for (const s of ev.submitted) addSubmitted({ ...s, blockNumber: ev.blockNumber });
    }
    for (const r of store.allBlocks().slice(-20)) addResult(r);
    return c.json(str({ submitted: [...pubRing].reverse().slice(0, limit), resultPosted: [...pubResults].reverse().slice(0, limit), hub: ADDR.hub, explorer: `${EXPLORER}/address/${ADDR.hub}` }));
  });

  app.post("/api/quote", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || !isAddress(b.tokenIn ?? "") || !isAddress(b.tokenOut ?? "")) throw new ApiError(400, "bad_request", "tokenIn and tokenOut must be addresses");
    const tokenIn = getAddress(b.tokenIn), tokenOut = getAddress(b.tokenOut);
    let amountIn: bigint;
    try { amountIn = BigInt(b.amountIn); } catch { throw new ApiError(400, "bad_request", "amountIn must be a base-unit integer string"); }
    const slip = b.slippageBps === undefined ? 50 : Number(b.slippageBps);
    if (!Number.isInteger(slip) || slip < 0 || slip > 10_000) throw new ApiError(400, "bad_request", "slippageBps must be an integer 0..10000");
    if (tokenIn === tokenOut) throw new ApiError(400, "same_token", "tokenIn equals tokenOut");
    const allowed = new Set([ADDR.tUSDC, ADDR.tUSDT]);
    if (!allowed.has(tokenIn) || !allowed.has(tokenOut)) throw new ApiError(400, "unsupported_token", "only tUSDC and tUSDT are supported");
    let out: bigint;
    try { out = await monad.readContract({ address: ADDR.swap, abi: mockSwapAbi, functionName: "quote", args: [tokenIn, tokenOut, amountIn] }); }
    catch { throw new ApiError(409, "no_rate", "MockSwap has no rate for this pair"); }
    const fee = await monad.readContract({ address: ADDR.bridge, abi: mainBridgeAbi, functionName: "relayerFee" });
    const net = out > fee ? out - fee : 0n;
    const suggestedMinOut = (net * BigInt(10_000 - slip)) / 10_000n;
    return c.json(str({ tokenIn, tokenOut, amountIn, quote: out, poolFeeBps: SWAP_INFO.poolFeeBps, relayerFee: fee, expectedNet: net, slippageBps: slip, suggestedMinOut, suggestedMaxFee: fee, simulated: true, venue: "MockSwap" }));
  });

  // ---------------------------------------------------------------- authenticated reads
  app.get("/api/whoami", async (c) => {
    const R = await auth(c);
    const ch = chain();
    const [fin, isAp, isAu] = await Promise.all([pub<Address>(ch.treasury, treasuryAbi, "financeLead"), pub<boolean>(ch.treasury, treasuryAbi, "isApprover", [R]), pub<boolean>(ch.treasury, treasuryAbi, "isAuditor", [R])]);
    const role = fin.toLowerCase() === R.toLowerCase() ? "finance" : isAp ? "approver" : isAu ? "auditor" : "payee";
    return c.json({ address: R, role, staff: role !== "payee" });
  });

  app.get("/api/nonce/:address", async (c) => {
    const R = await auth(c);
    const a = addrParam(c.req.param("address"));
    if (a !== R) throw new ApiError(403, "denied", "you may only read your own nonce");
    return c.json({ address: a, nonce: await domain.getTransactionCount({ address: a, blockTag: "latest" }) });
  });

  app.get("/api/balance/:address", async (c) => {
    const R = await auth(c);
    const a = addrParam(c.req.param("address"));
    const bal = await read<bigint>(R, chain().token, domainTokenAbi, "balanceOf", [a]);
    return c.json(str({ address: a, balance: bal, symbol: "pUSDC", decimals: 6 }));
  });

  app.get("/api/treasury", async (c) => {
    const R = await auth(c);
    const ch = chain();
    const bal = await read<bigint>(R, ch.treasury, treasuryAbi, "treasuryBalance");
    const [count, thr, fin, aps] = await Promise.all([pub<bigint>(ch.treasury, treasuryAbi, "batchCount"), pub<number>(ch.treasury, treasuryAbi, "threshold"), pub<Address>(ch.treasury, treasuryAbi, "financeLead"), pub<Address[]>(ch.treasury, treasuryAbi, "approvers")]);
    return c.json(str({ address: ch.treasury, balance: bal, batchCount: count, threshold: thr, financeLead: fin, approvers: aps }));
  });

  const batchView = async (R: Address, id: bigint, detail: boolean) => {
    const ch = chain();
    const b = await read<any>(R, ch.treasury, treasuryAbi, "getBatch", [id]);
    const [proposer, status, approvals, total, memoHash, payees, amounts] = b;
    if (Number(status) === 0) throw new ApiError(404, "not_found", `batch ${id} does not exist`);
    const out: any = { id, proposer, status: STATUS[Number(status)], approvals, total, memoHash, payeeCount: payees.length };
    if (detail) {
      const aps = await pub<Address[]>(ch.treasury, treasuryAbi, "approvers");
      out.approvedBy = (await Promise.all(aps.map(async (a) => ((await read<boolean>(R, ch.treasury, treasuryAbi, "hasApproved", [id, a])) ? a : null)))).filter(Boolean);
      out.payees = payees.map((p: Address, i: number) => ({ payee: p, amount: amounts[i] }));
      const led = store.allBlocks().filter((r) => r.epoch === store.state().epoch).find((r) => r.ledgerLeaves.some((l) => l.kind === 10 && l.batchId === id));
      if (led) out.executedAt = led.privateBlockTimestamp * 1000;
    }
    return out;
  };
  app.get("/api/batches", async (c) => {
    const R = await auth(c);
    const count = await pub<bigint>(chain().treasury, treasuryAbi, "batchCount");
    await read(R, chain().treasury, treasuryAbi, "treasuryBalance"); // staff gate even when there are no batches
    const list = await Promise.all(Array.from({ length: Number(count) }, (_, i) => batchView(R, BigInt(i + 1), false)));
    return c.json(str({ batches: list }));
  });
  app.get("/api/batches/:id", async (c) => {
    const R = await auth(c);
    if (!/^\d+$/.test(c.req.param("id"))) throw new ApiError(400, "bad_request", "invalid batch id");
    return c.json(str(await batchView(R, BigInt(c.req.param("id")), true)));
  });
  app.get("/api/batches/:id/payment/:payee", async (c) => {
    const R = await auth(c);
    if (!/^\d+$/.test(c.req.param("id"))) throw new ApiError(400, "bad_request", "invalid batch id");
    const payee = addrParam(c.req.param("payee"));
    const amt = await read<bigint>(R, chain().treasury, treasuryAbi, "paymentOf", [BigInt(c.req.param("id")), payee]);
    return c.json(str({ batchId: BigInt(c.req.param("id")), payee, amount: amt }));
  });

  app.get("/api/payments/:address", async (c) => {
    const R = await auth(c);
    const a = addrParam(c.req.param("address"));
    const ch = chain();
    await read(R, ch.treasury, treasuryAbi, "paymentOf", [0n, a]); // policy probe: self or staff, else 403
    const ep = store.state().epoch;
    const rows: any[] = [];
    for (const r of store.allBlocks()) {
      if (r.epoch !== ep) continue;
      for (const l of r.ledgerLeaves) {
        if (l.kind !== 10 || l.payee.toLowerCase() !== a.toLowerCase()) continue;
        const amt = await read<bigint>(R, ch.treasury, treasuryAbi, "paymentOf", [l.batchId, a]); // amount comes from the contract
        rows.push({ batchId: l.batchId, amount: amt, domainBlock: r.domainBlock, monadBlock: r.monadBlock, paidAt: r.privateBlockTimestamp * 1000 });
      }
    }
    return c.json(str({ address: a, payments: rows }));
  });

  app.get("/api/receipts/:payee/:batchId", async (c) => {
    const R = await auth(c);
    const payee = addrParam(c.req.param("payee"));
    if (!/^\d+$/.test(c.req.param("batchId"))) throw new ApiError(400, "bad_request", "invalid batch id");
    const batchId = BigInt(c.req.param("batchId"));
    const amt = await read<bigint>(R, chain().treasury, treasuryAbi, "paymentOf", [batchId, payee]);
    if (amt === 0n) throw new ApiError(404, "not_found", "no payment for this payee in this batch");
    const ep = store.state().epoch;
    const rec = store.allBlocks().find((r) => r.epoch === ep && r.ledgerLeaves.some((l) => l.kind === 10 && l.batchId === batchId && l.payee.toLowerCase() === payee.toLowerCase()));
    if (!rec) throw new ApiError(404, "not_found", "payment not found in the ledger (reset since?)");
    const leaf = rec.ledgerLeaves.find((l) => l.kind === 10 && l.batchId === batchId && l.payee.toLowerCase() === payee.toLowerCase())! as any;
    const tree = buildTree(rec.ledgerLeaves.map((l) => l.hash));
    const accepted = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "results", args: [rec.domainBlock] });
    const posted = accepted[0] !== `0x${"00".repeat(32)}`;
    return c.json(str({
      leaf: { kind: 10, batchId: leaf.batchId, payee: leaf.payee, amount: leaf.amount, salt: leaf.salt, hash: leaf.hash },
      proof: tree.proofOf(leaf.hash),
      stateRoot: rec.stateRoot, domainBlock: rec.domainBlock, monadBlock: rec.monadBlock,
      resultTx: rec.postTx ?? null, resultMonadBlock: rec.postedMonadBlock ?? null,
      hub: ADDR.hub, monadChainId: MONAD_CHAIN_ID,
      postedOnChain: posted, rootMatchesHub: posted && accepted[0] === rec.stateRoot,
    }));
  });

  // extra: public verification of a receipt against the root the Hub accepted on Monad (no private data needed)
  app.post("/api/receipts/verify", async (c) => {
    const b = await c.req.json().catch(() => null);
    try {
      const domainBlock = BigInt(b.domainBlock);
      const hash = ((): Hex => { const l = b.leaf; return leafHashOfPaid(l); })();
      const res = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "results", args: [domainBlock] });
      const root = res[0];
      const posted = root !== `0x${"00".repeat(32)}`;
      return c.json({ valid: posted && verifyProof(root, hash, b.proof), stateRootOnChain: root, leafHash: hash, domainBlock: domainBlock.toString() });
    } catch { throw new ApiError(400, "bad_request", "body must be {domainBlock, leaf:{batchId,payee,amount,salt}, proof:[...]}"); }
  });

  // ---------------------------------------------------------------- withdrawals + claim
  const leavesOf = (address: Address) => {
    const ep = store.state().epoch;
    const out: { rec: BlockRecord; leaf: MsgLeaf & { hash: Hex } }[] = [];
    for (const r of store.allBlocks()) {
      if (r.epoch !== ep) continue;
      for (const l of r.msgLeaves) if (l.payee.toLowerCase() === address.toLowerCase()) out.push({ rec: r, leaf: l });
    }
    return out;
  };
  const proofFor = (rec: BlockRecord, hash: Hex) => buildTree(rec.msgLeaves.map((l) => l.hash)).proofOf(hash);
  const leafStatus = async (rec: BlockRecord, hash: Hex, lastD: bigint) => {
    if (lastD < rec.domainBlock) return rec.postTx ? "posted" : "burned";
    if (store.state().claimed[hash]) return "claimed";
    const done = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "claimed", args: [hash] });
    if (done) { const st = store.state(); st.claimed[hash] = { tx: "0x" as Hex, at: Date.now() }; store.saveState(st); return "claimed"; }
    return "claimable";
  };
  app.get("/api/withdrawals/:address", async (c) => {
    const R = await auth(c);
    const a = addrParam(c.req.param("address"));
    if (R !== a && !(await read<boolean>(R, chain().token, domainTokenAbi, "isReader", [a, R]).catch(() => false))) throw new ApiError(403, "denied", "withdrawals are visible to the account itself (or a reader it granted)");
    const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
    const rows = [];
    for (const { rec, leaf } of leavesOf(a)) {
      const status = await leafStatus(rec, leaf.hash, lastD);
      const proof = proofFor(rec, leaf.hash);
      const w = leaf.kind === 1
        ? { kind: 1, payee: leaf.payee, token: leaf.token, amount: leaf.amount, nonce: leaf.nonce, salt: leaf.salt }
        : { kind: 2, payee: leaf.payee, tokenIn: leaf.tokenIn, tokenOut: leaf.tokenOut, amountIn: leaf.amountIn, minOut: leaf.minOut, maxFee: leaf.maxFee, nonce: leaf.nonce, salt: leaf.salt };
      rows.push({
        ...w, status, domainBlock: rec.domainBlock, monadBlock: rec.monadBlock, leafHash: leaf.hash, proof,
        resultTx: rec.postTx ?? null, claimTx: store.state().claimed[leaf.hash]?.tx ?? null,
        ...(leaf.kind === 2 ? { claimAsInput: { to: ADDR.hub, function: "claimAsInput", note: "payee-only: send this from the payee's own Monad account", args: { domainBlock: rec.domainBlock, w: { payee: leaf.payee, tokenIn: leaf.tokenIn, tokenOut: leaf.tokenOut, amountIn: leaf.amountIn, minOut: leaf.minOut, maxFee: leaf.maxFee, nonce: leaf.nonce }, salt: leaf.salt, proof } } } : {}),
      });
    }
    return c.json(str({ address: a, withdrawals: rows }));
  });

  const claiming = new Set<string>();
  app.post("/api/claim", async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || !isAddress(b.address ?? "") || b.nonce === undefined || !/^\d+$/.test(String(b.nonce))) throw new ApiError(400, "bad_request", "body must be {address, nonce}");
    const a = getAddress(b.address), nonce = BigInt(b.nonce);
    const hit = leavesOf(a).find((x) => x.leaf.nonce === nonce);
    if (!hit) throw new ApiError(404, "not_found", "no withdrawal with this nonce for this address in the current run");
    const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
    if (lastD < hit.rec.domainBlock) throw new ApiError(409, "not_posted", `domain block ${hit.rec.domainBlock} has not been posted to the Hub yet`);
    if (claiming.has(hit.leaf.hash)) throw new ApiError(409, "claim_in_progress", "a claim for this withdrawal is already being relayed");
    claiming.add(hit.leaf.hash);
    try {
      const r = await relayer.claim(hit.rec.domainBlock, hit.leaf, proofFor(hit.rec, hit.leaf.hash));
      const st = store.state();
      st.claimed[hit.leaf.hash] = { tx: r.tx, at: Date.now() };
      store.saveState(st);
      return c.json(str({ ...r, payee: a, nonce, domainBlock: hit.rec.domainBlock }));
    } finally { claiming.delete(hit.leaf.hash); }
  });

  // ---------------------------------------------------------------- demo
  app.get("/api/demo/accounts", (c) => {
    if (!DEMO_MODE) throw new ApiError(404, "not_found", "demo mode is off");
    const d = store.demo();
    if (!d) throw new ApiError(409, "not_bootstrapped", "no demo accounts; run pnpm bootstrap");
    return c.json({ note: "TESTNET DEMO KEYS ONLY. These accounts hold no value.", domainChainId: DOMAIN_CHAIN_ID, ...d, treasury: chain().treasury, token: chain().token });
  });
  app.post("/api/demo/reset", async (c) => {
    admin(c);
    const r = await resetDemo(op);
    statusCache = null;
    return c.json({ ...str(r), status: await (await app.request("/api/status")).json() });
  });
  app.post("/api/demo/mock-rate", async (c) => {
    admin(c);
    const b = await c.req.json().catch(() => null);
    let rate: bigint;
    try { rate = BigInt(b.rate); } catch { throw new ApiError(400, "bad_request", "rate must be an integer string scaled by 1e18 (1e18 = 1:1)"); }
    const tokenIn = b.tokenIn && isAddress(b.tokenIn) ? getAddress(b.tokenIn) : ADDR.tUSDC;
    const tokenOut = b.tokenOut && isAddress(b.tokenOut) ? getAddress(b.tokenOut) : ADDR.tUSDT;
    const r = await setMockRate(tokenIn, tokenOut, rate);
    statusCache = null;
    return c.json({ tokenIn, tokenOut, rate: rate.toString(), ...r });
  });

  // ---------------------------------------------------------------- server + WebSocket feed
  const server = serve({ fetch: app.fetch, port: API_PORT, hostname: API_HOST });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== "/api/events") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      ws.send(JSON.stringify({ type: "hello", serverTime: Date.now(), epoch: store.state().epoch }));
      if (u.searchParams.get("replay") !== "0") for (const e of feedRing.slice(-20)) ws.send(JSON.stringify(str(e)));
      const h = (e: FeedEvent) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(str(e))); };
      bus.on("feed", h);
      const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 20_000);
      ws.on("close", () => { bus.off("feed", h); clearInterval(ping); });
      ws.on("error", () => ws.terminate());
    });
  });
  void AUTH_WINDOW_S;
  return { server, app };
}

import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
function leafHashOfPaid(l: any): Hex {
  const enc = encodeAbiParameters(parseAbiParameters("uint8 kind, uint256 batchId, address payee, uint256 amount, bytes32 salt"), [10, BigInt(l.batchId), getAddress(l.payee), BigInt(l.amount), l.salt]);
  return keccak256(keccak256(enc));
}
