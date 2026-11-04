import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monad } from "./clients.js";
import { MONAD_CHAIN_ID } from "./config.js";

let gp = { v: 0n, at: 0 };
/** Gas price with a 20 s cache (avoids an RPC per tx). */
export async function gasPrice(): Promise<bigint> {
  if (Date.now() - gp.at > 20_000) gp = { v: await monad.getGasPrice(), at: Date.now() };
  return gp.v;
}
const isNonceErr = (e: unknown) => /nonce|already known|replacement/i.test(String((e as Error)?.message ?? e));

/**
 * One Monad EOA with locally tracked nonces (Monad best practice: no per-tx nonce RPC; sends are serialized
 * only for nonce assignment, so concurrent submissions go out as nonce, nonce+1, ...).
 */
export class NonceSender {
  readonly address: Address;
  private account;
  private next: number | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  constructor(pk: Hex) {
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
  }
  /** Warm the nonce and gas-price caches so the first send does no extra round trips. */
  async warm() { await Promise.all([this.resync(), gasPrice()]); }
  async warmGas() { gp.at = 0; await gasPrice().catch(() => undefined); }
  async resync() {
    this.next = await monad.getTransactionCount({ address: this.address, blockTag: "pending" });
  }
  send(req: { to: Address; data: Hex; gas: bigint }): Promise<{ hash: Hex; sentAt: number; maxCost: bigint }> {
    const run = async () => {
      const price = await gasPrice();
      const maxFeePerGas = (price * 12n) / 10n;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.next === null) await this.resync();
        const nonce = this.next!;
        try {
          const signed = await this.account.signTransaction({
            chainId: MONAD_CHAIN_ID, to: req.to, data: req.data, gas: req.gas, nonce, type: "eip1559",
            maxFeePerGas, maxPriorityFeePerGas: 1_000_000_000n, value: 0n,
          });
          const hash = (await monad.request({ method: "eth_sendRawTransaction", params: [signed] })) as Hex;
          this.next = nonce + 1;
          return { hash, sentAt: Date.now(), maxCost: req.gas * maxFeePerGas };
        } catch (e) {
          if (attempt < 2 && isNonceErr(e)) { this.next = null; continue; }
          this.next = null; // unknown outcome: resync before the next send
          throw e;
        }
      }
      throw new Error("unreachable");
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }
}
