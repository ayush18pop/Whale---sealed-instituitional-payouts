import { createPublicClient, createWalletClient, fallback, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_URL, MONAD_FALLBACKS, MONAD_HTTP, domainChain, monadChain } from "./config.js";

/** Monad HTTP reads/sends. Batching off (monadinfra fallback has no batch). */
export const monad = createPublicClient({
  chain: monadChain,
  transport: fallback([http(MONAD_HTTP, { retryCount: 2, retryDelay: 300 }), ...MONAD_FALLBACKS.map((u) => http(u))]),
});
export const monadWallet = (pk: Hex) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: monadChain, transport: http(MONAD_HTTP, { retryCount: 1 }) });

export const domain = createPublicClient({ chain: domainChain, cacheTime: 0, transport: http(ANVIL_URL, { retryCount: 0 }) });
export const domainWallet = (pk: Hex) =>
  createWalletClient({ account: privateKeyToAccount(pk), chain: domainChain, transport: http(ANVIL_URL, { retryCount: 0 }) });

/** Raw JSON-RPC to anvil for non-standard methods (evm_*, anvil_*). */
let rpcId = 1;
export async function anvilRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}
