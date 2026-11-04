import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AuthError, authMessage, verifyAuth } from "../src/auth.js";

const acct = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const now = 1_800_000_000_000;
const ts = String(now / 1000);
const sig = (a: typeof acct, t: string) => a.signMessage({ message: authMessage(t) });

describe("read auth", () => {
  it("accepts a valid signature", async () => {
    expect(await verifyAuth({ address: acct.address, timestamp: ts, signature: await sig(acct, ts) }, now)).toBe(acct.address);
  });
  it("accepts a lower-case address header", async () => {
    expect(await verifyAuth({ address: acct.address.toLowerCase(), timestamp: ts, signature: await sig(acct, ts) }, now)).toBe(acct.address);
  });
  it("rejects stale and future timestamps", async () => {
    const old = String(now / 1000 - 61), fut = String(now / 1000 + 61);
    await expect(verifyAuth({ address: acct.address, timestamp: old, signature: await sig(acct, old) }, now)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAuth({ address: acct.address, timestamp: fut, signature: await sig(acct, fut) }, now)).rejects.toBeInstanceOf(AuthError);
    const edge = String(now / 1000 - 59);
    await verifyAuth({ address: acct.address, timestamp: edge, signature: await sig(acct, edge) }, now);
  });
  it("rejects a wrong signer, a signature over another timestamp, and garbage", async () => {
    await expect(verifyAuth({ address: acct.address, timestamp: ts, signature: await sig(other, ts) }, now)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAuth({ address: acct.address, timestamp: ts, signature: await sig(acct, String(now / 1000 - 5)) }, now)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAuth({ address: acct.address, timestamp: ts, signature: "0x1234" }, now)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyAuth({ address: acct.address, timestamp: ts }, now)).rejects.toBeInstanceOf(AuthError);
  });
});
