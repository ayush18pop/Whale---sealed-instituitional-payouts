import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hubAbi } from "../src/abis.js";
import { ADDR, MONAD_CHAIN_ID, secrets } from "../src/config.js";
import { monad } from "../src/clients.js";
import { buildTree, leafHash, randomSalt, verifyProof, ZERO32, type PaidLeaf } from "../src/merkle.js";
import { recoverAddress } from "viem";
import { resultDigest, signDigest, sortSignatures } from "../src/digest.js";

const hub = { address: ADDR.hub, abi: hubAbi } as const;
const A = getAddress("0x1111111111111111111111111111111111111111");
const B = getAddress("0x2222222222222222222222222222222222222222");

describe("leaf hashes equal the deployed Hub's Solidity views (live Monad testnet)", () => {
  it("kind 1 withdrawalLeaf", async () => {
    const salt = randomSalt();
    const onchain = await monad.readContract({ ...hub, functionName: "withdrawalLeaf", args: [A, ADDR.tUSDC, 123456n, 7n, salt] });
    expect(leafHash({ kind: 1, payee: A, token: ADDR.tUSDC, amount: 123456n, nonce: 7n, salt })).toBe(onchain);
  });
  it("kind 2 swapWithdrawalLeaf", async () => {
    const salt = randomSalt();
    const w = { payee: A, tokenIn: ADDR.tUSDC, tokenOut: ADDR.tUSDT, amountIn: 5_000_000n, minOut: 4_900_000n, maxFee: 50_000n, nonce: 3n };
    const onchain = await monad.readContract({ ...hub, functionName: "swapWithdrawalLeaf", args: [w, salt] });
    expect(leafHash({ kind: 2, ...w, salt })).toBe(onchain);
  });
});

describe("mixed-kind tree", () => {
  it("proofs verify, tampering fails, empty root is zero, single leaf root is the leaf", () => {
    const l1 = leafHash({ kind: 1, payee: A, token: ADDR.tUSDC, amount: 1n, nonce: 0n, salt: randomSalt() });
    const l2 = leafHash({ kind: 2, payee: B, tokenIn: ADDR.tUSDC, tokenOut: ADDR.tUSDT, amountIn: 2n, minOut: 1n, maxFee: 1n, nonce: 0n, salt: randomSalt() });
    const l3 = leafHash({ kind: 1, payee: B, token: ADDR.tUSDC, amount: 9n, nonce: 1n, salt: randomSalt() });
    const t = buildTree([l1, l2, l3]);
    for (const l of [l1, l2, l3]) expect(verifyProof(t.root, l, t.proofOf(l))).toBe(true);
    const p = t.proofOf(l1);
    p[0] = ("0x" + "00".repeat(31) + "01") as Hex;
    expect(verifyProof(t.root, l1, p)).toBe(false);
    expect(buildTree([]).root).toBe(ZERO32);
    expect(buildTree([l1]).root).toBe(l1);
  });
  it("ledger tree (kind 10 + 11) proofs verify", () => {
    const paid: PaidLeaf[] = Array.from({ length: 50 }, (_, i) => ({ kind: 10, batchId: 1n, payee: getAddress("0x" + (i + 1).toString(16).padStart(40, "0")), amount: BigInt(1000 + i), salt: randomSalt() }));
    const hs = [...paid.map(leafHash), leafHash({ kind: 11, privateBlockHash: randomSalt(), salt: randomSalt() })];
    const t = buildTree(hs);
    for (const h of hs) expect(verifyProof(t.root, h, t.proofOf(h))).toBe(true);
  });
});

describe("result digest and signatures (live Hub)", () => {
  it("local digest equals Hub.resultDigest", async () => {
    const stateRoot = randomSalt(), msgRoot = randomSalt();
    const onchain = await monad.readContract({ ...hub, functionName: "resultDigest", args: [5n, 77n, stateRoot, msgRoot] });
    expect(resultDigest({ hub: ADDR.hub, monadChainId: MONAD_CHAIN_ID, domainBlock: 5n, monadBlock: 77n, stateRoot, msgRoot })).toBe(onchain);
  });
  it("two operators sign raw; ascending-signer sigs are accepted by postResult (simulated against live state); wrong order/block rejected", async () => {
    const [lastD, lastM, head] = await Promise.all([
      monad.readContract({ ...hub, functionName: "lastDomainBlock" }),
      monad.readContract({ ...hub, functionName: "lastMonadBlock" }),
      monad.getBlockNumber(),
    ]);
    const domainBlock = lastD + 1n, monadBlock = head;
    expect(monadBlock > lastM).toBe(true);
    const stateRoot = randomSalt(), msgRoot = ZERO32;
    const digest = resultDigest({ hub: ADDR.hub, monadChainId: MONAD_CHAIN_ID, domainBlock, monadBlock, stateRoot, msgRoot });
    const [pk1, pk2] = secrets.operators();
    const s = [await signDigest(pk1, digest), await signDigest(pk2, digest)];
    expect(await recoverAddress({ hash: digest, signature: s[0].signature })).toBe(privateKeyToAccount(pk1).address);
    const sorted = sortSignatures(s);
    const account = privateKeyToAccount(pk1);
    const sim = (db: bigint, sigs: Hex[]) => monad.simulateContract({ ...hub, account, functionName: "postResult", args: [db, monadBlock, stateRoot, msgRoot, sigs] });
    await sim(domainBlock, sorted); // does not throw: accepted
    const reversed = [...sorted].reverse();
    await expect(sim(domainBlock, reversed)).rejects.toThrow(/SignersNotAscending/);
    await expect(sim(domainBlock + 1n, sorted)).rejects.toThrow(/OutOfOrder/);
    await expect(sim(domainBlock, [sorted[0]])).rejects.toThrow(/NotEnoughSignatures/);
  });
});
