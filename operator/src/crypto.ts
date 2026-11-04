/**
 * Whale crypto module: shared by the operator and the browser (copy this file).
 * Depends only on `eciesjs` (0.5.0, exact) and `viem` (hex helpers). No Node built-ins.
 *
 * Scheme (eciesjs 0.5.0 defaults, ECIES_CONFIG, nothing overridden):
 *   curve secp256k1, ephemeral key UNcompressed (65 B), HKDF over uncompressed keys,
 *   AES-256-GCM with a 16-byte nonce.
 * Ciphertext layout: ephemeralPublicKey(65) || nonce(16) || tag(16) || aesGcmCiphertext(len(plaintext)).
 * Overhead: 97 bytes. Plaintext = the signed raw EVM transaction bytes.
 */
import { encrypt, decrypt, ECIES_CONFIG } from "eciesjs";
import { bytesToHex, hexToBytes, type Hex } from "viem";

export const ECIES_OVERHEAD_BYTES = 97;
export const CRYPTO_SPEC = {
  library: "eciesjs",
  version: "0.5.0",
  ellipticCurve: ECIES_CONFIG.ellipticCurve,
  isEphemeralKeyCompressed: ECIES_CONFIG.isEphemeralKeyCompressed,
  isHkdfKeyCompressed: ECIES_CONFIG.isHkdfKeyCompressed,
  symmetricAlgorithm: ECIES_CONFIG.symmetricAlgorithm,
  symmetricNonceLength: ECIES_CONFIG.symmetricNonceLength,
  layout: "ephemeralPublicKey(65) || nonce(16) || tag(16) || ciphertext",
  overheadBytes: ECIES_OVERHEAD_BYTES,
} as const;

/** Encrypt a signed raw transaction (0x hex) to the operator's 65-byte uncompressed public key. */
export function encryptTx(operatorPublicKey: Hex, signedRawTx: Hex): Hex {
  return bytesToHex(encrypt(hexToBytes(operatorPublicKey), hexToBytes(signedRawTx)));
}

/** Operator side. Throws on any failure (wrong key, tampering, truncation). */
export function decryptTx(operatorPrivateKey: Hex, ciphertext: Hex): Hex {
  return bytesToHex(decrypt(hexToBytes(operatorPrivateKey), hexToBytes(ciphertext)));
}
