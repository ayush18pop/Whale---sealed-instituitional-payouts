import { config as loadEnv } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineChain, getAddress, type Address, type Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
export const OPERATOR_DIR = resolve(here, "..");
export const REPO_DIR = resolve(OPERATOR_DIR, "..");
loadEnv({ path: resolve(REPO_DIR, ".env"), quiet: true });
loadEnv({ path: resolve(OPERATOR_DIR, ".env"), quiet: true });

const dep = JSON.parse(readFileSync(resolve(REPO_DIR, "deployments/monad-testnet.json"), "utf8"));

function env(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (def !== undefined) return def;
    throw new Error(`missing env ${name}`);
  }
  return v;
}
const pk = (name: string) => env(name) as Hex;

export const DATA_DIR = resolve(OPERATOR_DIR, env("DATA_DIR", "./data"));
export const API_PORT = Number(env("API_PORT", "8787"));
export const API_HOST = env("API_HOST", "127.0.0.1");
export const CORS_ORIGIN = env("CORS_ORIGIN", "http://localhost:3000");
export const ANVIL_PORT = Number(env("ANVIL_PORT", "8777"));
export const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
export const ANVIL_MONAD_MODE = env("ANVIL_MONAD_MODE", "1") === "1";
export const DEMO_MODE = env("DEMO_MODE", "1") === "1";
export const DEMO_ADMIN_TOKEN = env("DEMO_ADMIN_TOKEN", "");
export const RELAYER_MAX_INFLIGHT = Number(env("RELAYER_MAX_INFLIGHT", "12"));
export const CRASH_AT = env("WHALE_CRASH_AT", "");

export const DOMAIN_CHAIN_ID = 7777;
export const MONAD_CHAIN_ID = 10143;
export const MONAD_HTTP = env("MONAD_TESTNET_RPC", dep.rpc);
export const MONAD_FALLBACKS = env("MONAD_RPC_FALLBACKS", "").split(",").filter(Boolean);
export const MONAD_WS: string = dep.ws;
export const EXPLORER: string = dep.explorer;

export const monadChain = defineChain({
  id: MONAD_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_HTTP], webSocket: [MONAD_WS] } },
});
export const domainChain = defineChain({
  id: DOMAIN_CHAIN_ID,
  name: "Whale Private Domain",
  nativeCurrency: { name: "Private", symbol: "PRV", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
});

const a = (x: string) => getAddress(x);
export const ADDR = {
  hub: a(dep.contracts.Hub.address),
  bridge: a(dep.contracts.MainBridge.address),
  swap: a(dep.contracts.MockSwap.address),
  tUSDC: a(dep.tokens.tUSDC.address),
  tUSDT: a(dep.tokens.tUSDT.address),
  deployer: a(dep.deployer),
};
export const HUB_DEPLOY_BLOCK = BigInt(dep.contracts.Hub.blockNumber);
export const MAINBRIDGE_DEPLOY_BLOCK = BigInt(dep.contracts.MainBridge.blockNumber);
export const SWAP_INFO = {
  adapter: "MockSwap",
  simulated: true as const,
  relayerFeeFlat: String(dep.swap.relayerFeeFlat),
  poolFeeBps: dep.swap.poolFeeBps as number,
};

/** Secrets: accessed only through these functions; never log their results. */
export const secrets = {
  deployer: () => pk("DEPLOYER_PRIVATE_KEY"),
  operators: () => [pk("OPERATOR_PK_1"), pk("OPERATOR_PK_2"), pk("OPERATOR_PK_3")],
  relayers: () => [pk("RELAYER_PK_1"), pk("RELAYER_PK_2")],
  systemRelayer: () => pk("SYSTEM_RELAYER_PK"),
  encPrivate: () => env("ENC_PRIVATE_KEY") as Hex,
};
export const SYSTEM_RELAYER_ADDR = a(env("SYSTEM_RELAYER_ADDR"));
export const ENC_PUBLIC_KEY = env("ENC_PUBLIC_KEY") as Hex;

/** Gas constants (measured, see scripts/measure-gas.ts and docs/API.md). */
export const GAS = {
  submitBase: BigInt(env("GAS_SUBMIT_BASE", "30000")),
  submitPerByte: BigInt(env("GAS_SUBMIT_PER_BYTE", "42")),
  postResult: BigInt(env("GAS_POST_RESULT", "160000")),
  claim: BigInt(env("GAS_CLAIM", "250000")),
  claimSwap: BigInt(env("GAS_CLAIM_SWAP", "400000")),
};
