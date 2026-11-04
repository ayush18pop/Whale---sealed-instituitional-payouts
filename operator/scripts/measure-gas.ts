/** Measures gas via eth_estimateGas (free) for Hub.submit across ciphertext sizes and for postResult. */
import { encodeFunctionData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDR, MONAD_CHAIN_ID, secrets } from "../src/config.js";
import { monad } from "../src/clients.js";
import { hubAbi } from "../src/abis.js";
import { randomSalt } from "../src/merkle.js";
import { resultDigest, signDigest, sortSignatures } from "../src/digest.js";

const relayer = privateKeyToAccount(secrets.relayers()[0]).address;
const pts: [number, bigint][] = [];
for (const n of [100, 500, 1000, 2000, 4000, 8000, 16000, 32000, 65536]) {
  const data = encodeFunctionData({ abi: hubAbi, functionName: "submit", args: [`0x${"ab".repeat(n)}` as Hex, 2_000_000n] });
  const g = await monad.estimateGas({ account: relayer, to: ADDR.hub, data });
  pts.push([n, g]);
  console.log(`submit ciphertext ${n} B -> estimateGas ${g}`);
  await new Promise((r) => setTimeout(r, 150));
}
const [a, b] = [pts[0], pts[pts.length - 1]];
const perByte = Number(b[1] - a[1]) / (b[0] - a[0]);
console.log(`linear fit: ${Math.round(Number(a[1]) - perByte * a[0])} + ${perByte.toFixed(2)} * bytes`);
// worst deviation of a line through the endpoints
for (const [n, g] of pts) console.log(`  ${n}: est ${g} line ${Math.round(Number(a[1]) + perByte * (n - a[0]))}`);

const lastD = await monad.readContract({ address: ADDR.hub, abi: hubAbi, functionName: "lastDomainBlock" });
const head = await monad.getBlockNumber();
const stateRoot = randomSalt(), msgRoot = randomSalt();
const digest = resultDigest({ hub: ADDR.hub, monadChainId: MONAD_CHAIN_ID, domainBlock: lastD + 1n, monadBlock: head, stateRoot, msgRoot });
const [k1, k2] = secrets.operators();
const sigs = sortSignatures([await signDigest(k1, digest), await signDigest(k2, digest)]);
const data = encodeFunctionData({ abi: hubAbi, functionName: "postResult", args: [lastD + 1n, head, stateRoot, msgRoot, sigs] });
console.log("postResult estimateGas", await monad.estimateGas({ account: privateKeyToAccount(k1).address, to: ADDR.hub, data }));
