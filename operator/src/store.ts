import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import type { Address, Hex } from "viem";
import type { MsgLeaf, LedgerLeaf } from "./merkle.js";

/** JSON with bigint support: bigint <-> "bn:123". */
export const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `bn:${x}` : x), 2);
export const de = <T>(s: string): T => JSON.parse(s, (_k, x) => (typeof x === "string" && /^bn:\d+$/.test(x) ? BigInt(x.slice(3)) : x));

function atomicWrite(path: string, content: string) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path); // atomic on POSIX
}
function readJson<T>(path: string, def: T): T {
  return existsSync(path) ? de<T>(readFileSync(path, "utf8")) : def;
}

export interface SubmissionOutcome {
  id: Hex; // Hub tx hash
  courier: Address;
  gasLimit: bigint;
  monadBlock: bigint;
  logIndex: number;
  innerHash?: Hex;
  status: "executed" | "reverted" | "skipped";
  reason?: string;
  receivedAt?: number; // API receipt (ms epoch), only for relayer-submitted
  includedAt: number; // ms epoch the operator saw the Monad log
  monadBlockTimestamp?: number; // seconds
}
export interface DepositOutcome { depositId: bigint; to: Address; amount: bigint; mintTx?: Hex; skipped?: string }

export interface BlockRecord {
  epoch: number;
  domainBlock: bigint;
  monadBlock: bigint;
  privateBlock: bigint;
  privateBlockHash: Hex;
  privateBlockTimestamp: number;
  stateRoot: Hex;
  msgRoot: Hex;
  msgLeaves: (MsgLeaf & { hash: Hex })[];
  ledgerLeaves: (LedgerLeaf & { hash: Hex })[];
  /** Private-chain tx hash that produced each Paid / withdrawal event, for reference. */
  deposits: DepositOutcome[];
  submissions: SubmissionOutcome[];
  signers: Address[];
  timing: { startedAt: number; executedAt: number; execMs: number; signedAt?: number; postSentAt?: number; postedAt?: number };
  postTx?: Hex;
  postedMonadBlock?: bigint; // Monad block that included postResult
}

export interface State {
  cursorMonadBlock: bigint | null; // last Monad block whose events were fully handled
  inflight: null | { domainBlock: bigint; monadBlock: bigint; startPrivateBlock: bigint };
  epoch: number;
  claimed: Record<Hex, { tx: Hex; at: number }>; // leaf hash -> claim info
}

export interface ChainInfo {
  token: Address;
  treasury: Address;
  snapshotId: Hex | null;
  openingPrivateBlock: bigint;
  openingSupply: bigint; // total pUSDC minted at the opening position
  openingDepositMonadBlock: bigint;
  bootstrappedAt: string;
}
export interface DemoAccounts {
  finance: { address: Address; privateKey: Hex };
  approvers: { address: Address; privateKey: Hex }[];
  auditor: { address: Address; privateKey: Hex };
  payees: { address: Address; privateKey: Hex }[];
}

mkdirSync(join(DATA_DIR, "blocks"), { recursive: true });
const P = {
  state: join(DATA_DIR, "state.json"),
  chain: join(DATA_DIR, "private-chain.json"),
  demo: join(DATA_DIR, "demo-accounts.json"),
  block: (d: bigint) => join(DATA_DIR, "blocks", `${d}.json`),
  blocksDir: join(DATA_DIR, "blocks"),
};
export const paths = P;

export const store = {
  state: (): State => readJson<State>(P.state, { cursorMonadBlock: null, inflight: null, epoch: 1, claimed: {} }),
  saveState: (s: State) => atomicWrite(P.state, ser(s)),
  chain: (): ChainInfo | null => (existsSync(P.chain) ? readJson<ChainInfo>(P.chain, null as never) : null),
  saveChain: (c: ChainInfo) => atomicWrite(P.chain, ser(c)),
  demo: (): DemoAccounts | null => (existsSync(P.demo) ? readJson<DemoAccounts>(P.demo, null as never) : null),
  saveDemo: (d: DemoAccounts) => atomicWrite(P.demo, ser(d)),
  block: (d: bigint): BlockRecord | null => (existsSync(P.block(d)) ? readJson<BlockRecord>(P.block(d), null as never) : null),
  saveBlock: (b: BlockRecord) => atomicWrite(P.block(b.domainBlock), ser(b)),
  allBlocks: (): BlockRecord[] =>
    readdirSync(P.blocksDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<BlockRecord>(join(P.blocksDir, f), null as never))
      .sort((a, b) => (a.domainBlock < b.domainBlock ? -1 : 1)),
};
