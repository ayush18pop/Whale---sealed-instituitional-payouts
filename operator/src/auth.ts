import { getAddress, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";

export const AUTH_WINDOW_S = 60;
export const authMessage = (timestamp: string | number) => `whale-read:${timestamp}`;

export class AuthError extends Error {}

/**
 * Verify x-address / x-timestamp / x-signature (EIP-191 personal_sign over "whale-read:{timestamp}").
 * Returns the verified (checksummed) address, or throws AuthError (-> 401).
 */
export async function verifyAuth(h: { address?: string | null; timestamp?: string | null; signature?: string | null }, nowMs = Date.now()): Promise<Address> {
  if (!h.address || !h.timestamp || !h.signature) throw new AuthError("missing x-address, x-timestamp or x-signature");
  if (!isAddress(h.address, { strict: false })) throw new AuthError("x-address is not an address");
  if (!/^\d{1,12}$/.test(h.timestamp)) throw new AuthError("x-timestamp must be unix seconds");
  const skew = Math.abs(nowMs / 1000 - Number(h.timestamp));
  if (skew > AUTH_WINDOW_S) throw new AuthError(`x-timestamp outside the +-${AUTH_WINDOW_S}s window`);
  let recovered: Address;
  try {
    recovered = await recoverMessageAddress({ message: authMessage(h.timestamp), signature: h.signature as Hex });
  } catch { throw new AuthError("x-signature is not a valid signature"); }
  if (recovered.toLowerCase() !== h.address.toLowerCase()) throw new AuthError("signature does not match x-address");
  return getAddress(h.address);
}
