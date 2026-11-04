import { decodeErrorResult, type Hex } from "viem";
import { hubAbi, mainBridgeAbi, mockSwapAbi, poolSeederAbi, testUSDCAbi, uniswapV4AdapterAbi } from "./abis.js";

/** Every custom error a Hub claim can bubble up (Hub, MainBridge, MockSwap, UniswapV4Adapter (Slippage, PartialFill, NotBridge, WrongPair, ...), PoolSeeder, OZ SafeERC20/ERC20). */
const ERR_ABIS = [hubAbi, mainBridgeAbi, mockSwapAbi, uniswapV4AdapterAbi, poolSeederAbi, testUSDCAbi];
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

