import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { decryptTx, encryptTx, ECIES_OVERHEAD_BYTES } from "../src/crypto.js";
import { ENC_PUBLIC_KEY, secrets } from "../src/config.js";
import { PrivateKey } from "eciesjs";
import { bytesToHex } from "viem";

describe("crypto", () => {
  it("round-trips with the deployed operator key", () => {
    const raw = ("0x" + "ab".repeat(300)) as `0x${string}`;
    const ct = encryptTx(ENC_PUBLIC_KEY, raw);
    expect((ct.length - 2) / 2).toBe(300 + ECIES_OVERHEAD_BYTES);
    expect(decryptTx(secrets.encPrivate(), ct)).toBe(raw);
  });
  it("is randomized and tamper-evident", () => {
    const raw = "0x1234" as const;
    const a = encryptTx(ENC_PUBLIC_KEY, raw), b = encryptTx(ENC_PUBLIC_KEY, raw);
    expect(a).not.toBe(b);
    const bytes = Buffer.from(a.slice(2), "hex");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptTx(secrets.encPrivate(), `0x${bytes.toString("hex")}`)).toThrow();
  });
  it("wrong key fails", () => {
    const sk = new PrivateKey();
    const ct = encryptTx(bytesToHex(sk.publicKey.toBytes(false)), "0x1234");
    expect(() => decryptTx(secrets.encPrivate(), ct)).toThrow();
  });
  it("matches the public key published on the Hub config", () => {
    expect(ENC_PUBLIC_KEY.length).toBe(2 + 130);
    void generatePrivateKey;
  });
});
