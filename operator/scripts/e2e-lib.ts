import WebSocket from "ws";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { API_PORT, DOMAIN_CHAIN_ID } from "../src/config.js";
import { authMessage } from "../src/auth.js";
import { encryptTx } from "../src/crypto.js";
import { domain } from "../src/clients.js";
import type { FeedEvent } from "../src/events.js";

export const BASE = `http://127.0.0.1:${API_PORT}`;
export type Acct = { address: Address; privateKey: Hex };

export class Http {
  constructor(public status: number, public body: any) {}
}
export async function api(path: string, o: { as?: Acct; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Http> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  if (o.as) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-address"] = o.as.address;
    headers["x-timestamp"] = ts;
    headers["x-signature"] = await privateKeyToAccount(o.as.privateKey).signMessage({ message: authMessage(ts) });
  }
  const r = await fetch(BASE + path, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await r.text();
  let j: any; try { j = JSON.parse(text); } catch { j = text; }
  return new Http(r.status, j);
}

/** WebSocket feed client with automatic reconnect; keeps every event for later inspection. */
export class Feed {
  events: (FeedEvent & { _at: number })[] = [];
  private ws?: WebSocket;
  private listeners: ((e: any) => void)[] = [];
  private closed = false;
  start() {
    const connect = () => {
      if (this.closed) return;
      const ws = new WebSocket(`ws://127.0.0.1:${API_PORT}/api/events?replay=0`);
      this.ws = ws;
      ws.on("message", (m) => { const e = JSON.parse(m.toString()); e._at = Date.now(); this.events.push(e); for (const l of this.listeners) l(e); });
      ws.on("close", () => setTimeout(connect, 300));
      ws.on("error", () => undefined);
    };
    connect();
  }
  stop() { this.closed = true; this.ws?.terminate(); }
  waitFor<T = any>(pred: (e: any) => boolean, timeoutMs = 60_000, label = "event"): Promise<T> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.listeners = this.listeners.filter((l) => l !== h); rej(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
      const h = (e: any) => { if (pred(e)) { clearTimeout(t); this.listeners = this.listeners.filter((l) => l !== h); res(e as T); } };
      this.listeners.push(h);
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const stats = (xs: number[]) => ({ n: xs.length, min: Math.min(...xs), median: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });

/** Build a signed inner (domain) tx: legacy, gas price 0, chain 7777. */
export async function signInner(a: Acct, to: Address, data: Hex, gas: bigint, nonce: number): Promise<Hex> {
  return privateKeyToAccount(a.privateKey).signTransaction({ chainId: DOMAIN_CHAIN_ID, to, data, gas, nonce, gasPrice: 0n, type: "legacy", value: 0n });
}
export const callData = (abi: any, fn: string, args: unknown[]) => encodeFunctionData({ abi, functionName: fn, args } as any);
export const gasFor = async (a: Acct, to: Address, data: Hex) => {
  const est = await domain.estimateGas({ account: a.address, to, data });
  return (est * 130n) / 100n + 20_000n;
};
export { getAddress, encryptTx };
