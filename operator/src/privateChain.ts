import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { REPO_DIR } from "./config.js";
import { anvilRpc, domain } from "./clients.js";

export function artifact(name: string, file: string): { abi: any[]; bytecode: Hex } {
  const j = JSON.parse(readFileSync(resolve(REPO_DIR, `contracts/out/${file}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
}

/** Mine exactly one block (automine is off). Returns the new block number. */
export async function mineOne(): Promise<bigint> {
  await anvilRpc("evm_mine", []);
  return domain.getBlockNumber();
}

export const snapshot = () => anvilRpc<Hex>("evm_snapshot", []);
export const revert = (id: Hex) => anvilRpc<boolean>("evm_revert", [id]);
export const dropPool = () => anvilRpc("anvil_dropAllTransactions", []);
export const poolStatus = () => anvilRpc<{ pending: Hex; queued: Hex }>("txpool_status", []);
export const tracked = (a: string): Address => getAddress(a);
