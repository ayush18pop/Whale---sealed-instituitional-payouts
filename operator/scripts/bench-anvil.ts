/**
 * Private-chain cost of Monad mode vs plain mode for a 50-payee batch (no Monad testnet traffic).
 *   pnpm tsx scripts/bench-anvil.ts [runs]
 * Per run: evm_snapshot, propose(50) mined, approve#1 mined, approve#2 (executes 50 transfers) timed from
 * eth_sendRawTransaction to the end of evm_mine, then evm_revert. Wall clock on this machine.
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, http, defineChain, getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ADDR, secrets, SYSTEM_RELAYER_ADDR } from "../src/config.js";
import { artifact } from "../src/privateChain.js";
import { stats } from "./e2e-lib.js";

const RUNS = Number(process.argv[2] ?? 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bench(mode: "monad" | "plain", port: number) {
  const args = [...(mode === "monad" ? ["--network", "monad"] : []), "--chain-id", "7777", "--no-mining", "--order", "fifo", "--gas-price", "0", "--base-fee", "0", "--port", String(port), "--accounts", "1", "--quiet"];
  const p = spawn("anvil", args, { stdio: "ignore" });
  await sleep(1500);
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ id: 7777, name: "x", nativeCurrency: { name: "x", symbol: "x", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, cacheTime: 0, transport: http(url) });
  const rpc = async (method: string, params: unknown[] = []) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as any).result;
  const mk = () => { const k = generatePrivateKey(); return { k, a: privateKeyToAccount(k) }; };
  const fin = mk(), aps = [mk(), mk(), mk()], payees = Array.from({ length: 50 }, mk);
  const w = (k: Hex) => createWalletClient({ account: privateKeyToAccount(k), chain, transport: http(url) });
  const base = { gasPrice: 0n, type: "legacy" as const };
  const dt = artifact("DomainToken", "DomainToken"), tr = artifact("Treasury", "Treasury");
  const t1 = await w(fin.k).sendTransaction({ ...base, gas: 5_000_000n, nonce: 0, data: encodeDeployData({ abi: dt.abi, bytecode: dt.bytecode, args: [SYSTEM_RELAYER_ADDR, ADDR.tUSDC] }) } as any);
  await rpc("evm_mine");
  const token = getAddress((await pub.getTransactionReceipt({ hash: t1 })).contractAddress!);
  const t2 = await w(fin.k).sendTransaction({ ...base, gas: 5_000_000n, nonce: 1, data: encodeDeployData({ abi: tr.abi, bytecode: tr.bytecode, args: [token, fin.a.address, aps.map((a) => a.a.address), 2] }) } as any);
  await rpc("evm_mine");
  const treasury = getAddress((await pub.getTransactionReceipt({ hash: t2 })).contractAddress!);
  await w(secrets.systemRelayer()).sendTransaction({ ...base, gas: 200_000n, nonce: 0, to: token, data: encodeFunctionData({ abi: dt.abi, functionName: "mintDeposit", args: [1n, treasury, 10n ** 12n] }) } as any);
  await rpc("evm_mine");
  const amounts = payees.map((_, i) => BigInt(1_000_000_000 + i));
  const send = async (k: Hex, to: `0x${string}`, data: Hex, nonce: number) => {
    const raw = await privateKeyToAccount(k).signTransaction({ chainId: 7777, to, data, gas: 6_000_000n, nonce, gasPrice: 0n, type: "legacy", value: 0n });
    return (await rpc("eth_sendRawTransaction", [raw])) as Hex;
  };
  const exec: number[] = [], propose: number[] = [];
  let gasApprove = 0n, gasPropose = 0n;
  for (let i = 0; i < RUNS + 2; i++) {
    const snap = await rpc("evm_snapshot");
    let t0 = performance.now();
    const hp = await send(fin.k, treasury, encodeFunctionData({ abi: tr.abi, functionName: "propose", args: [payees.map((p) => p.a.address), amounts, `0x${"00".repeat(32)}`] }), 2);
    await rpc("evm_mine");
    const tp = performance.now() - t0;
    gasPropose = (await pub.getTransactionReceipt({ hash: hp })).gasUsed;
    const ap = (n: number) => encodeFunctionData({ abi: tr.abi, functionName: "approve", args: [1n] });
    await send(aps[0].k, treasury, ap(0), 0);
    await rpc("evm_mine");
    t0 = performance.now();
    const h2 = await send(aps[1].k, treasury, ap(1), 0);
    await rpc("evm_mine");
    const te = performance.now() - t0;
    const rc = await pub.getTransactionReceipt({ hash: h2 });
    if (rc.status !== "success") throw new Error("approve 2 failed");
    gasApprove = rc.gasUsed;
    if (i >= 2) { exec.push(te); propose.push(tp); } // first two runs are warm-up
    await rpc("evm_revert", [snap]);
  }
  p.kill("SIGTERM");
  return { mode, runs: exec.length, gasPropose, gasApprove, execMs: stats(exec), proposeMs: stats(propose) };
}

const out = [];
for (const [m, port] of [["monad", 8791], ["plain", 8792], ["monad", 8793], ["plain", 8794]] as const) out.push(await bench(m, port));
for (const o of out) console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
