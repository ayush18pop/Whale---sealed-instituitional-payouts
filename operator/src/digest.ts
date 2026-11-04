import { keccak256, encodeAbiParameters, hashMessage, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DOMAIN_CHAIN_ID } from "./config.js";

/** Local recomputation of Hub.resultDigest (EIP-191 wrapped). Verified against the live Hub in tests. */
export function resultDigest(p: {
  hub: Address; monadChainId: number; domainBlock: bigint; monadBlock: bigint; stateRoot: Hex; msgRoot: Hex;
}): Hex {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
      [p.hub, BigInt(p.monadChainId), BigInt(DOMAIN_CHAIN_ID), p.domainBlock, p.monadBlock, p.stateRoot, p.msgRoot],
    ),
  );
  // toEthSignedMessageHash(bytes32) = keccak256("\x19Ethereum Signed Message:\n32" ++ inner)
  return hashMessage({ raw: inner });
}

/** Sign the 32-byte Hub digest as a RAW hash (no further prefixing). */
export async function signDigest(pk: Hex, digest: Hex): Promise<{ signer: Address; signature: Hex }> {
  const acct = privateKeyToAccount(pk);
  const signature = await acct.sign({ hash: digest });
  return { signer: acct.address, signature };
}

/** Sort signatures by strictly ascending signer address (what Hub.postResult requires). */
export function sortSignatures(sigs: { signer: Address; signature: Hex }[]): Hex[] {
  return [...sigs]
    .sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : BigInt(a.signer) > BigInt(b.signer) ? 1 : 0))
    .map((s) => s.signature);
}
