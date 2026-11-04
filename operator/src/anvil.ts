import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { closeSync, openSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ANVIL_MONAD_MODE, ANVIL_PORT, DATA_DIR, DOMAIN_CHAIN_ID } from "./config.js";

export const ANVIL_STATE = join(DATA_DIR, "anvil-state.json");
export const ANVIL_PID = join(DATA_DIR, "anvil.pid");

/**
 * Flags (verified with `anvil --help`, Foundry 1.8.7):
 *  --network monad     Monad EVM rules (optional; ANVIL_MONAD_MODE=0 for plain mode)
 *  --chain-id 7777     domain chain id
 *  --no-mining         automine off: the operator mines exactly one block per domain block (evm_mine)
 *  --order fifo        FIFO transaction ordering
 *  --gas-price 0 --base-fee 0   domain users never need a native balance
 *  --state PATH        load on start + dump on exit; --state-interval dumps periodically so an
 *                      anvil crash loses at most a few seconds
 */
export function anvilArgs(opts: { monad?: boolean } = {}): string[] {
  const monad = opts.monad ?? ANVIL_MONAD_MODE;
  return [
    ...(monad ? ["--network", "monad"] : []),
    "--chain-id", String(DOMAIN_CHAIN_ID),
    "--no-mining", "--order", "fifo",
    "--gas-price", "0", "--base-fee", "0",
    "--port", String(ANVIL_PORT),
    "--accounts", "1",
    "--state", ANVIL_STATE, "--state-interval", "3",
    "--quiet",
  ];
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("error", () => res(false));
  });
}

/** Start anvil detached (survives the operator process) if nothing listens on the port. */
export async function ensureAnvil(opts: { fresh?: boolean; monad?: boolean } = {}): Promise<"started" | "already-running"> {
  if (await portOpen(ANVIL_PORT)) {
    if (opts.fresh) throw new Error(`anvil already running on ${ANVIL_PORT}; stop it first (pnpm anvil:stop) to bootstrap fresh`);
    return "already-running";
  }
  if (opts.fresh && existsSync(ANVIL_STATE)) rmSync(ANVIL_STATE);
  const log = openSync(join(DATA_DIR, "anvil.log"), "a");
  const child = spawn("anvil", anvilArgs(opts), { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  writeFileSync(ANVIL_PID, String(child.pid));
  for (let i = 0; i < 50; i++) {
    if (await portOpen(ANVIL_PORT)) return "started";
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

export function stopAnvil() {
  if (!existsSync(ANVIL_PID)) return;
  const pid = Number(readFileSync(ANVIL_PID, "utf8"));
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  rmSync(ANVIL_PID);
}
