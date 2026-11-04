import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { parseEventLogs, type Address, type Hex, type Log } from "viem";
import { ADDR, MONAD_WS } from "./config.js";
import { hubAbi, mainBridgeAbi } from "./abis.js";
import { monad } from "./clients.js";

export interface MonadEvents {
  blockNumber: bigint;
  blockTimestamp?: number;
  submitted: { id: Hex; logIndex: number; courier: Address; gasLimit: bigint; ciphertext: Hex }[];
  deposits: { id: Hex; logIndex: number; depositId: bigint; token: Address; from: Address; domainRecipient: Address; amount: bigint }[];
  other: { name: string; txHash: Hex; logIndex: number; args: any }[];
}

/**
 * Raw `ws` JSON-RPC client for Monad: eth_subscribe newHeads + logs (Hub, MainBridge).
 * Used only as a low-latency TRIGGER and head tracker; the authoritative event set for a block
 * is read with eth_getLogs (fetchBlockEvents) so completeness never depends on subscription delivery.
 * Reconnects with exponential backoff and emits "open" after each (re)connect so the consumer can catch up.
 * Emits: "head"(bigint), "rawlog"(raw eth log object), "open", "close".
 */
export class MonadWatcher extends EventEmitter {
  head = 0n;
  private ws?: WebSocket;
  private stopped = false;
  private backoff = 500;
  private lastMsg = 0;
  private watchdog?: NodeJS.Timeout;
  connected = false;
  /** ms epoch the head was last observed, for "included" latency. */
  headSeenAt = 0;

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.ws && Date.now() - this.lastMsg > 8000) this.ws.terminate(); // blocks arrive every ~0.4 s
    }, 2000);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    this.ws?.terminate();
  }

  private connect() {
    const ws = new WebSocket(MONAD_WS);
    this.ws = ws;
    ws.on("open", () => {
      this.lastMsg = Date.now();
      this.backoff = 500;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["logs", { address: [ADDR.hub, ADDR.bridge] }] }));
      this.connected = true;
      this.emit("open");
    });
    ws.on("message", (raw) => {
      this.lastMsg = Date.now();
      let j: any;
      try { j = JSON.parse(raw.toString()); } catch { return; }
      if (j.method !== "eth_subscription") return;
      const r = j.params?.result;
      if (!r) return;
      if (r.parentHash !== undefined && r.number !== undefined && r.logIndex === undefined) {
        const n = BigInt(r.number);
        if (n > this.head) { this.head = n; this.headSeenAt = Date.now(); this.emit("head", n); }
      } else if (r.blockNumber !== undefined) {
        this.emit("rawlog", r);
      }
    });
    const onDown = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.emit("close");
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
    ws.on("close", onDown);
    ws.on("error", () => { /* "close" follows */ });
  }
}

/** Authoritative events for one Monad block (retries if the serving node lags the WS node). */
export async function fetchBlockEvents(blockNumber: bigint, expectAtLeast = 1): Promise<MonadEvents> {
  let logs: Log[] = [];
  for (let i = 0; i < 12; i++) {
    logs = await monad.getLogs({ address: [ADDR.hub, ADDR.bridge], fromBlock: blockNumber, toBlock: blockNumber });
    if (logs.length >= expectAtLeast) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return classify(blockNumber, logs);
}

/** Events for a range (<= 100 blocks per eth_getLogs on the public RPC; verified: 1000 is rejected). */
export async function fetchRange(from: bigint, to: bigint): Promise<MonadEvents[]> {
  const out = new Map<bigint, Log[]>();
  for (let s = from; s <= to; s += 90n) {
    const e = s + 89n > to ? to : s + 89n;
    const logs = await monad.getLogs({ address: [ADDR.hub, ADDR.bridge], fromBlock: s, toBlock: e });
    for (const l of logs) {
      const arr = out.get(l.blockNumber!) ?? [];
      arr.push(l);
      out.set(l.blockNumber!, arr);
    }
    await new Promise((r) => setTimeout(r, 60)); // stay far below the 25 rps eth_call-class limit
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, logs]) => classify(n, logs));
}

function classify(blockNumber: bigint, logs: Log[]): MonadEvents {
  const sorted = [...logs].sort((a, b) => a.logIndex! - b.logIndex!);
  const hubLogs = parseEventLogs({ abi: hubAbi, logs: sorted.filter((l) => l.address.toLowerCase() === ADDR.hub.toLowerCase()) });
  const brLogs = parseEventLogs({ abi: mainBridgeAbi, logs: sorted.filter((l) => l.address.toLowerCase() === ADDR.bridge.toLowerCase()) });
  const ev: MonadEvents = { blockNumber, submitted: [], deposits: [], other: [] };
  for (const l of hubLogs) {
    if (l.eventName === "Submitted") {
      ev.submitted.push({ id: l.transactionHash!, logIndex: l.logIndex!, courier: l.args.courier, gasLimit: l.args.gasLimit, ciphertext: l.args.ciphertext });
    } else ev.other.push({ name: l.eventName, txHash: l.transactionHash!, logIndex: l.logIndex!, args: l.args });
  }
  for (const l of brLogs) {
    if (l.eventName === "Deposit") {
      ev.deposits.push({ id: l.transactionHash!, logIndex: l.logIndex!, depositId: l.args.depositId, token: l.args.token, from: l.args.from, domainRecipient: l.args.domainRecipient, amount: l.args.amount });
    } else ev.other.push({ name: l.eventName, txHash: l.transactionHash!, logIndex: l.logIndex!, args: l.args });
  }
  return ev;
}
