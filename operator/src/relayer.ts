import { decodeErrorResult, encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { ADDR, GAS, RELAYER_MAX_INFLIGHT, secrets } from "./config.js";
import { monad } from "./clients.js";
import { hubAbi, mainBridgeAbi, mockSwapAbi, testUSDCAbi } from "./abis.js";
import { NonceSender } from "./monadTx.js";
import { bus, emitFeed, receivedAtById, type FeedEvent } from "./events.js";
import type { MsgLeaf } from "./merkle.js";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) { super(message); }
}

/** Every custom error a Hub claim can bubble up (Hub, MainBridge, MockSwap, OZ SafeERC20/ERC20). */
const ERR_ABIS = [hubAbi, mainBridgeAbi, mockSwapAbi, testUSDCAbi];
export function decodeRevert(e: unknown): { name: string; args?: readonly unknown[]; raw?: Hex } | null {
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++, cur = cur.cause) {
    const data: Hex | undefined = typeof cur.data === "string" ? cur.data : cur.data?.data ?? cur.raw;
    if (typeof data === "string" && data.startsWith("0x") && data.length >= 10) {
      for (const abi of ERR_ABIS) {
        try { const d = decodeErrorResult({ abi: abi as any, data }); return { name: d.errorName, args: d.args as any }; } catch { /* next abi */ }
      }
      return { name: "UnknownError", raw: data };
    }
  }
  return null;
}

/** Reserve-balance budget (PRD 7.1): cap in-flight fees per relayer. Monad bills the gas LIMIT, so budget by limit * price. */
const MAX_INFLIGHT_COST_WEI = 3n * 10n ** 18n; // well under the 10 MON reserve
const WAIT_QUEUE_MS = 20_000;

interface Slot { sender: NonceSender; inflight: Map<Hex, { cost: bigint; at: number }>; balance: bigint; balAt: number }

export class Relayer {
  private slots: Slot[];
  private rr = 0;
  private waiters: (() => void)[] = [];
  constructor() {
    this.slots = secrets.relayers().map((pk) => ({ sender: new NonceSender(pk), inflight: new Map(), balance: 0n, balAt: 0 }));
    bus.on("feed", (e: FeedEvent) => { if (e.type === "included") this.release(e.id); });
    setInterval(() => this.reap(), 10_000).unref();
  }
  get addresses() { return this.slots.map((s) => s.sender.address); }
  async warm() { await Promise.all(this.slots.map((s) => s.sender.warm())); }

  submitGas(ctBytes: number): bigint { return GAS.submitBase + GAS.submitPerByte * BigInt(ctBytes); }

  private release(hash: Hex) {
    for (const s of this.slots) s.inflight.delete(hash);
    const w = this.waiters.shift();
    if (w) w();
  }
  private reap() { // a tx not seen for 90 s is treated as lost; free its budget
    const now = Date.now();
    for (const s of this.slots) for (const [h, v] of s.inflight) if (now - v.at > 90_000) { s.inflight.delete(h); s.sender.resync().catch(() => undefined); }
  }
  private async pick(cost: bigint): Promise<Slot> {
    const deadline = Date.now() + WAIT_QUEUE_MS;
    for (;;) {
      const n = this.slots.length;
      for (let i = 0; i < n; i++) {
        const s = this.slots[(this.rr + i) % n];
        const used = [...s.inflight.values()].reduce((a, v) => a + v.cost, 0n);
        if (s.inflight.size >= RELAYER_MAX_INFLIGHT || used + cost > MAX_INFLIGHT_COST_WEI) continue;
        if (Date.now() - s.balAt > 30_000) { s.balance = await monad.getBalance({ address: s.sender.address }); s.balAt = Date.now(); }
        if (s.balance < used + cost) continue; // cannot fund it: try the other relayer
        this.rr = (this.rr + i + 1) % n;
        return s;
      }
      if (Date.now() > deadline) throw new ApiError(503, "relayer_busy", "all relayers are at their in-flight or balance limit; retry shortly");
      await new Promise<void>((res) => { this.waiters.push(res); setTimeout(res, 500); });
    }
  }

  /** Hub.submit(ciphertext, gasLimit) from a relayer EOA. Returns as soon as the tx is sent (not included). */
  async submit(ciphertext: Hex, gasLimit: bigint, receivedAt: number): Promise<{ id: Hex; hubTx: Hex; receivedAt: number }> {
    const bytes = (ciphertext.length - 2) / 2;
    const gas = this.submitGas(bytes);
    const data = encodeFunctionData({ abi: hubAbi, functionName: "submit", args: [ciphertext, gasLimit] });
    const cost = gas * 130_000_000_000n;
    let slot = await this.pick(cost);
    let sent: { hash: Hex; sentAt: number; maxCost: bigint } | undefined;
    for (let attempt = 0; attempt < 2 && !sent; attempt++) {
      try {
        sent = await slot.sender.send({
          to: ADDR.hub, data, gas,
          onSigned: (h) => { receivedAtById.set(h, receivedAt); slot.inflight.set(h, { cost, at: Date.now() }); },
        });
        slot.balance -= cost; // conservative local balance estimate between 30 s refreshes
      } catch (e) {
        slot.balance = 0n; slot.balAt = Date.now(); // treat as unfunded until the next refresh; try the other relayer once
        if (attempt === 1) throw new ApiError(502, "relay_failed", `Monad rejected the submission: ${String((e as Error).message).slice(0, 300)}`);
        slot = await this.pick(cost).catch(() => { throw new ApiError(502, "relay_failed", `Monad rejected the submission: ${String((e as Error).message).slice(0, 300)}`); });
      }
    }
    if (!sent) throw new ApiError(502, "relay_failed", "submission failed");
    if (receivedAtById.size > 5000) for (const k of [...receivedAtById.keys()].slice(0, 2500)) receivedAtById.delete(k);
    emitFeed({ type: "submitted", id: sent.hash, hubTx: sent.hash, receivedAt, gasLimit: gasLimit.toString(), ciphertextBytes: bytes, relayer: slot.sender.address, sentAt: sent.sentAt });
    return { id: sent.hash, hubTx: sent.hash, receivedAt };
  }

  /** Claim a posted withdrawal. kind 1 -> Hub.claim, kind 2 -> Hub.claimSwap (relayer earns the flat fee). */
  async claim(domainBlock: bigint, leaf: MsgLeaf, proof: Hex[]) {
    const data =
      leaf.kind === 1
        ? encodeFunctionData({ abi: hubAbi, functionName: "claim", args: [domainBlock, leaf.payee, leaf.token, leaf.amount, leaf.nonce, leaf.salt, proof] })
        : encodeFunctionData({
            abi: hubAbi, functionName: "claimSwap",
            args: [domainBlock, { payee: leaf.payee, tokenIn: leaf.tokenIn, tokenOut: leaf.tokenOut, amountIn: leaf.amountIn, minOut: leaf.minOut, maxFee: leaf.maxFee, nonce: leaf.nonce }, leaf.salt, proof],
          });
    const slot = await this.pick(GAS.claimSwap * 130_000_000_000n);
    // Never retry blindly: simulate once (this also sizes the gas limit), surface the decoded revert.
    let est: bigint;
    try {
      est = await monad.estimateGas({ account: slot.sender.address, to: ADDR.hub, data });
    } catch (e) {
      const d = decodeRevert(e);
      throw new ApiError(409, "claim_reverted", d ? `claim would revert: ${d.name}` : `claim would revert: ${String((e as Error).message).slice(0, 200)}`, { revert: d ? { name: d.name, args: d.args?.map(String) } : null });
    }
    const gas = (est * 125n) / 100n;
    const sent = await slot.sender.send({ to: ADDR.hub, data, gas, onSigned: (h) => slot.inflight.set(h, { cost: gas * 130_000_000_000n, at: Date.now() }) });
    const rc = await this.waitReceipt(sent.hash);
    slot.inflight.delete(sent.hash);
    if (rc.status !== "success") throw new ApiError(409, "claim_reverted", "claim transaction reverted on Monad", { tx: sent.hash });
    const br = parseEventLogs({ abi: mainBridgeAbi, logs: rc.logs.filter((l) => l.address.toLowerCase() === ADDR.bridge.toLowerCase()) });
    let received: { token: string; amount: string } | null = null;
    let feePaid = "0";
    for (const l of br) {
      if (l.eventName === "Released") received = { token: l.args.token, amount: l.args.amount.toString() };
      if (l.eventName === "ReleasedWithSwap") { received = { token: l.args.tokenOut, amount: l.args.amountOutNet.toString() }; feePaid = l.args.fee.toString(); }
    }
    return { tx: sent.hash, kind: leaf.kind === 1 ? "claim" : "claimSwap", gasLimit: gas.toString(), received, feePaid, relayer: slot.sender.address, monadBlock: rc.blockNumber.toString() };
  }

  /** Wait for a Monad receipt: the WS feed's "claimed" event is the trigger; getTransactionReceipt is called once it fires. */
  private async waitReceipt(hash: Hex) {
    const fired = new Promise<void>((res) => {
      const h = (e: FeedEvent) => { if (e.type === "claimed" && e.tx === hash) { bus.off("feed", h); res(); } };
      bus.on("feed", h);
      setTimeout(() => { bus.off("feed", h); res(); }, 6000);
    });
    await fired;
    for (let i = 0; i < 40; i++) {
      const rc = await monad.getTransactionReceipt({ hash }).catch(() => null);
      if (rc) return rc;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new ApiError(504, "claim_timeout", `claim tx ${hash} not confirmed in 20 s`, { tx: hash });
  }
}
