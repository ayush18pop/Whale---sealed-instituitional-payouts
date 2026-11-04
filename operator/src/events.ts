import { EventEmitter } from "node:events";
import type { Hex } from "viem";

/** In-process feed. The API forwards every "feed" event over WebSocket. */
export const bus = new EventEmitter();
export type FeedEvent =
  | { type: "submitted"; id: Hex; hubTx: Hex; receivedAt: number; gasLimit: string; ciphertextBytes: number; relayer: string; sentAt: number }
  | { type: "included"; id: Hex; monadBlock: string; includedAt: number; receivedToIncludedMs: number | null }
  | {
      type: "domainBlock"; domainBlock: string; monadBlock: string; privateBlock: string; privateBlockHash: Hex;
      execMs: number; executedAt: number;
      txs: { id: Hex; status: string; reason?: string; receivedToIncludedMs: number | null; includedToExecutedMs: number; receivedToExecutedMs: number | null }[];
      deposits: { depositId: string; to: string; amount: string; skipped?: string }[];
      withdrawals: number; payments: number;
    }
  | {
      type: "resultPosted"; domainBlock: string; monadBlock: string; stateRoot: Hex; msgRoot: Hex; postTx: Hex; signers: string[];
      postedAt: number; executedToPostedMs: number;
      txs: { id: Hex; receivedToPostedMs: number | null; includedToPostedMs: number }[];
    }
  | { type: "claimed"; kind: "claim" | "claimSwap" | "claimAsInput"; domainBlock: string; payee: string; tx: Hex; at: number; token?: string; amount?: string; nonce: string };

export const emitFeed = (e: FeedEvent) => bus.emit("feed", e);

/** API receipt times for relayer-submitted txs (ms epoch), keyed by Hub tx hash. */
export const receivedAtById = new Map<Hex, number>();
