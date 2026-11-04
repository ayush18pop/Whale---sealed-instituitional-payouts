/**
 * Merkle helpers. Leaf hashes follow OpenZeppelin's StandardMerkleTree leaf rule
 * keccak256(bytes.concat(keccak256(abi.encode(...)))) (what Hub.withdrawalLeaf computes), but trees are built with
 * SimpleMerkleTree over those hashes, because one tree must mix leaf kinds with different shapes
 * (StandardMerkleTree requires one uniform leaf encoding). Node hashing is OZ's sorted-pair keccak,
 * which is exactly what OpenZeppelin MerkleProof.verify (used by the Hub) checks.
 */
import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem";

export const ZERO32: Hex = `0x${"00".repeat(32)}`;

const T_WITHDRAWAL = parseAbiParameters("uint8 kind, address payee, address token, uint256 amount, uint256 nonce, bytes32 salt");
const T_SWAP = parseAbiParameters(
  "uint8 kind, address payee, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 maxFee, uint256 nonce, bytes32 salt",
);
const T_PAID = parseAbiParameters("uint8 kind, uint256 batchId, address payee, uint256 amount, bytes32 salt");
const T_BLOCK = parseAbiParameters("uint8 kind, bytes32 privateBlockHash, bytes32 salt");

const dbl = (enc: Hex): Hex => keccak256(keccak256(enc));

export interface WithdrawalLeaf { kind: 1; payee: Address; token: Address; amount: bigint; nonce: bigint; salt: Hex }
export interface SwapLeaf {
  kind: 2; payee: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; minOut: bigint; maxFee: bigint; nonce: bigint; salt: Hex;
}
export interface PaidLeaf { kind: 10; batchId: bigint; payee: Address; amount: bigint; salt: Hex }
export interface BlockLeaf { kind: 11; privateBlockHash: Hex; salt: Hex }
export type MsgLeaf = WithdrawalLeaf | SwapLeaf;
export type LedgerLeaf = PaidLeaf | BlockLeaf;

export function leafHash(l: MsgLeaf | LedgerLeaf): Hex {
  switch (l.kind) {
    case 1: return dbl(encodeAbiParameters(T_WITHDRAWAL, [1, l.payee, l.token, l.amount, l.nonce, l.salt]));
    case 2: return dbl(encodeAbiParameters(T_SWAP, [2, l.payee, l.tokenIn, l.tokenOut, l.amountIn, l.minOut, l.maxFee, l.nonce, l.salt]));
    case 10: return dbl(encodeAbiParameters(T_PAID, [10, l.batchId, l.payee, l.amount, l.salt]));
    case 11: return dbl(encodeAbiParameters(T_BLOCK, [11, l.privateBlockHash, l.salt]));
  }
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return `0x${Buffer.from(b).toString("hex")}`;
}

export interface BuiltTree { root: Hex; hashes: Hex[]; proofOf(hash: Hex): Hex[] }

/** Build a tree over already-hashed leaves. Empty input gives root 0x00..00 (no withdrawals). */
export function buildTree(hashes: Hex[]): BuiltTree {
  if (hashes.length === 0) return { root: ZERO32, hashes, proofOf: () => { throw new Error("empty tree"); } };
  const tree = SimpleMerkleTree.of(hashes);
  return { root: tree.root as Hex, hashes, proofOf: (h) => tree.getProof(h) as Hex[] };
}

export function verifyProof(root: Hex, leaf: Hex, proof: Hex[]): boolean {
  return SimpleMerkleTree.verify(root, leaf, proof);
}
