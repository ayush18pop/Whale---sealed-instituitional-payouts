# Whale backend API

Contract between the backend (`operator/`) and the frontend. Everything here was implemented and exercised by
`operator/scripts/e2e.ts` against the live Monad testnet (chain 10143) and a local private chain (chain 7777).

- Base URL: `http://127.0.0.1:8787` (`API_PORT`, `API_HOST`). CORS allows `http://localhost:3000` (`CORS_ORIGIN`).
- JSON in and out. **All integers that may exceed 2^53 are decimal strings** (amounts are base units, 6 decimals:
  `"1000000000"` = 1000.000000). Block numbers are also strings. `nonce` in `GET /api/nonce` is a JS number.
- Errors are always `{ "error": "<code>", "message": "..." }` (some add fields, see "Errors").
- Addresses may be sent in any case; responses use EIP-55 checksum case.

Run: `cd operator && pnpm bootstrap && pnpm start` (see `operator/README.md`).

## 1. Crypto spec (inner transaction encryption)

Copy `operator/src/crypto.ts` into the browser. It depends only on `eciesjs` and `viem`.

| Item | Value |
|---|---|
| Library | `eciesjs` **0.5.0** (exact; browser and Node) |
| Config | library defaults (`ECIES_CONFIG`), nothing overridden |
| Curve | secp256k1 |
| Recipient key | `GET /api/crypto` `publicKey`: 65-byte uncompressed `0x04...` (also `Hub.operatorEncryptionKey()`) |
| Ephemeral key in payload | uncompressed (65 B) |
| KDF | HKDF over the uncompressed ephemeral and shared public keys |
| Cipher | AES-256-GCM, 16-byte nonce |
| Ciphertext layout | `ephemeralPublicKey(65) \|\| nonce(16) \|\| tag(16) \|\| aesGcmCiphertext(len(plaintext))` |
| Overhead | 97 bytes |
| Plaintext | the **signed raw EVM transaction bytes** (`0x` hex, what `eth_sendRawTransaction` takes) |

```ts
import { encryptTx } from "./crypto";            // encryptTx(publicKeyHex, signedRawTxHex) -> 0x ciphertext
const ct = encryptTx(publicKey, rawSignedTx);
```

### Inner transaction

- Chain id **7777**, **legacy** type (`type: "legacy"`, as `viem` calls it), `gasPrice: 0`, `value: 0`. (An EIP-1559 tx with
  `maxFeePerGas: 0` also parses; legacy is what was tested.) Domain users need no native balance.
- `to` must be the private `DomainToken` or `Treasury` (addresses in `GET /api/status` `contracts`). Any other
  destination is skipped by the operator (status `skipped`).
- `nonce` = the sender's private-chain nonce: `GET /api/nonce/:address`. Wait for your previous tx to be executed
  (`domainBlock` event) before sending the next one from the same account.
- `gasLimit` (also passed to `POST /api/submit`) = the inner tx gas limit, 1..30,000,000. Measured gas on the private
  chain (Monad mode): `Treasury.propose` with 50 payees 3,399,674; `approve` that executes 50 payments 1,895,314
  (3,588,151 and 1,759,726 in plain mode). The e2e uses `eth_estimateGas` x1.3 + 20,000 for ordinary calls and
  6,000,000 for the executing approval.
- Ciphertext size limit 65,536 bytes. A 50-payee `propose` is a 3,467-byte signed tx, 3,564 bytes encrypted.

## 2. Read authentication

Private reads need three headers:

| Header | Value |
|---|---|
| `x-address` | the caller's address |
| `x-timestamp` | unix seconds, within +-60 s of server time (`serverTime` in `/api/status` is ms) |
| `x-signature` | EIP-191 `personal_sign` of the string `whale-read:{timestamp}` by `x-address` |

```ts
const ts = String(Math.floor(Date.now() / 1000));
const sig = await account.signMessage({ message: `whale-read:${ts}` });   // viem
fetch(url, { headers: { "x-address": addr, "x-timestamp": ts, "x-signature": sig } });
```

Missing/invalid/stale -> **401 `unauthorized`**. Valid but not permitted -> **403 `denied`**. The 403 is genuine: the
server makes the private-chain call with `from` set to the verified address and the **contract** decides
(`DomainToken.balanceOf` and `Treasury.getBatch/paymentOf/treasuryBalance` revert `Denied()`). The server never uses a
privileged `from` for reads. The private chain's raw RPC is not exposed. Signatures are not nonce-protected: anyone
who captures one can replay it for 60 s (acceptable for the testnet demo).

"Staff" = `Treasury.financeLead`, an approver, or an auditor (the auditor is set by `Treasury.setAuditor`, done at
bootstrap). A "reader" is an address the account granted via `DomainToken.grantReader`.

## 3. Endpoints

### `GET /api/status` (public)

```json
{
  "chainIds": { "monad": 10143, "domain": 7777 },
  "monad": { "head": "76874558", "lastDomainBlock": "2", "lastMonadBlock": "76873598" },
  "domain": { "privateHead": "4", "lastDomainBlock": "2" },
  "lastResult": { "domainBlock": "2", "monadBlock": "76873598", "stateRoot": "0x..", "msgRoot": "0x..", "postTx": "0x.." },
  "contracts": { "hub": "0xBAf9..", "bridge": "0xbB22..", "mockSwap": "0x82F5..", "tUSDC": "0xCd12..", "tUSDT": "0x1F2C..",
                 "domainToken": "0x3a8a..", "treasury": "0x8F90..", "systemRelayer": "0xFb55.." },
  "tokens": { "tUSDC": { "address": "0x..", "decimals": 6 }, "tUSDT": { "address": "0x..", "decimals": 6 }, "pUSDC": { "address": "0x..", "decimals": 6 } },
  "swap": { "adapter": "MockSwap", "simulated": true, "rates": { "tUSDC>tUSDT": "1000000000000000000", "tUSDT>tUSDC": "1000000000000000000" },
            "rateScale": "1e18", "poolFeeBps": 5, "relayerFee": "50000" },
  "operator": { "status": "idle", "lastError": null, "monadWsConnected": true, "cursorMonadBlock": "76873598" },
  "relayers": ["0x350A..", "0xA46E.."],
  "epoch": 1, "demoMode": true, "explorer": "https://testnet.monadscan.com", "serverTime": 1793782726732
}
```
`operator.status`: `starting | idle | processing | paused | error`. Cached for 1.5 s. `epoch` increments on every reset.
`swap.relayerFee` is in output-token base units (flat). `simulated: true` means the swap venue is MockSwap: label it
**Simulated** in the UI.

### `GET /api/crypto` (public)

Returns `{ publicKey, publishedOn: { hub, fn }, scheme: {library, version, ellipticCurve, ...layout, overheadBytes},
domainChainId: 7777, maxCiphertextBytes: 65536, maxGasLimit: 30000000 }`.

### `POST /api/submit` (public)

Request `{ "ciphertext": "0x...", "gasLimit": "2000000" }` (gasLimit string or number). Response, returned as soon as
the Monad tx is sent (not included):

```json
{ "id": "0x52c0..(hub tx hash)", "hubTx": "0x52c0..", "receivedAt": 1793782734123 }
```
`receivedAt` is the server clock in ms at API receipt (start of the timing chain). Use `id` to match the WebSocket
events. Errors: 400 `bad_request`, 400 `ciphertext_too_large`, 400 `bad_gas_limit`, 413 body too large,
503 `relayer_busy`, 502 `relay_failed`.

Relayer: two EOAs, round-robin, local nonces, no `eth_estimateGas`. Gas limit per submit = `30000 + 42 x ciphertext
bytes` (derived from measured `eth_estimateGas`: 23,732 + 40.02/byte fitted, e.g. 100 B -> 27,734; 4,000 B -> 182,517;
65,536 B -> 2,646,708; Monad's calldata floor makes random bytes cost about 40 gas each). In-flight cap per relayer
(`RELAYER_MAX_INFLIGHT`, default 12) and a fee budget (3 MON of limit x price); excess requests wait up to 20 s.

### `GET /api/events` (WebSocket) (public)

`ws://127.0.0.1:8787/api/events` (append `?replay=0` to skip the replay of the last 20 events). First message
`{ "type": "hello", "serverTime": ms, "epoch": n }`. All times are ms epoch on the server clock; `*Ms` are durations.

```jsonc
{ "type": "submitted", "id": "0x..", "hubTx": "0x..", "receivedAt": 1793782734123, "gasLimit": "2000000",
  "ciphertextBytes": 3564, "relayer": "0x350A..", "sentAt": 1793782734300 }

{ "type": "included", "id": "0x..", "monadBlock": "76875243", "includedAt": 1793782734900,   // operator saw the Hub log on its WS
  "receivedToIncludedMs": 777 }                                                               // null if not relayed by this server

{ "type": "domainBlock", "domainBlock": "3", "monadBlock": "76875243", "privateBlock": "5", "privateBlockHash": "0x..",
  "execMs": 24, "executedAt": 1793782735100,
  "txs": [ { "id": "0x..", "status": "executed" /* executed | reverted | skipped */, "reason": "..?",
             "receivedToIncludedMs": 777, "includedToExecutedMs": 200, "receivedToExecutedMs": 977 } ],
  "deposits": [ { "depositId": "2", "to": "0x..", "amount": "500000000000", "skipped": "..?" } ],
  "withdrawals": 0, "payments": 50 }

{ "type": "resultPosted", "domainBlock": "3", "monadBlock": "76875243", "stateRoot": "0x..", "msgRoot": "0x..",
  "postTx": "0x..", "signers": ["0xd22A..", "0x92b7.."], "postedAt": 1793782736000, "executedToPostedMs": 900,
  "txs": [ { "id": "0x..", "receivedToPostedMs": 1900, "includedToPostedMs": 1100 } ] }

{ "type": "claimed", "kind": "claim" /* claim | claimSwap | claimAsInput */, "domainBlock": "6", "payee": "0x..",
  "tx": "0x..", "at": 1793782740000, "token": "0x..", "amount": "1000000000", "nonce": "0" }

{ "type": "reset", "epoch": 2 }
```
Timing semantics: `execMs` = private-chain work for the block (send the txs + mine one block, operator clock).
`includedAt` is when the operator received the Hub log on its Monad WebSocket subscription (block timestamps are
whole seconds, too coarse). `resultPosted` fires when the `ResultPosted` log of the Hub tx arrives on the same
subscription. The server and the clients of the e2e share one clock, so cross-event differences are valid; if the
browser is on another machine, use the `*Ms` fields rather than comparing with its own clock.

### `GET /api/public/hub-events?limit=20` (public)

What a public observer sees on Monad. `submitted[]` newest first: `{ type, id, courier, gasLimit, ciphertextBytes,
ciphertextPreview (first 33 bytes), monadBlock, explorer }`; `resultPosted[]`: `{ type, domainBlock, monadBlock,
stateRoot, msgRoot, tx, explorer }`; plus `hub` and an address `explorer` link. Fed by the operator plus a one-time
look-back of 1,800 Monad blocks (about 10 minutes) on the first call after a restart; older events are not listed.

### `GET /api/nonce/:address` (self) -- extra, needed to build inner txs

`{ "address": "0x..", "nonce": 3 }`; 403 for another address.

### `GET /api/whoami` (any valid signature) -- extra, for the role switcher

`{ "address": "0x..", "role": "finance|approver|auditor|payee", "staff": true }` (read from `Treasury`).

### `GET /api/balance/:address` (auth)

`{ "address": "0x..", "balance": "1000000000", "symbol": "pUSDC", "decimals": 6 }`. 403 `denied` unless the caller is
the account or a granted reader (decided by `DomainToken.balanceOf`).

### `GET /api/payments/:address` (self or staff)

```json
{ "address": "0x..", "payments": [ { "batchId": "1", "amount": "1000000000", "domainBlock": "5", "monadBlock": "76875278", "paidAt": 1793783358000 } ] }
```
Amount is read from `Treasury.paymentOf` as the caller. `paidAt` is the private block timestamp in ms. Only payments of
the current epoch (since the last reset) are listed.

### `GET /api/treasury` (staff)

`{ "address", "balance", "batchCount", "threshold": 2, "financeLead", "approvers": [..] }` (balance from
`Treasury.treasuryBalance` as the caller).

### `GET /api/batches`, `GET /api/batches/:id` (staff)

List item: `{ id, proposer, status: "Pending|Executed|Cancelled", approvals, total, memoHash, payeeCount }`.
Detail adds `approvedBy: [addr..]`, `payees: [{ payee, amount }]` and, once executed, `executedAt` (ms). 404 `not_found`
for an unknown id.

### `GET /api/batches/:id/payment/:payee` (payee or staff)

`{ "batchId": "1", "payee": "0x..", "amount": "1000000000" }`.

### `GET /api/receipts/:payee/:batchId` (payee or staff)

```json
{
  "leaf": { "kind": 10, "batchId": "1", "payee": "0x..", "amount": "1000000000", "salt": "0x..", "hash": "0x.." },
  "proof": ["0x..", "0x.."],
  "stateRoot": "0x..", "domainBlock": "5", "monadBlock": "76875278",
  "resultTx": "0x..", "resultMonadBlock": "76875281",
  "hub": "0xBAf9..", "monadChainId": 10143,
  "postedOnChain": true, "rootMatchesHub": true
}
```
Verify client side: `leaf.hash = keccak256(keccak256(abi.encode(uint8 10, uint256 batchId, address payee, uint256 amount,
bytes32 salt)))`; then `SimpleMerkleTree.verify(Hub.results(domainBlock).stateRoot, leaf.hash, proof)` (OpenZeppelin
sorted-pair keccak). 404 if the payee has no payment in that batch. The ledger tree (`stateRoot`) holds one kind-10 leaf per
`Treasury.Paid` event of the block plus one kind-11 leaf `[uint8 11, bytes32 privateBlockHash, bytes32 salt]`.

### `POST /api/receipts/verify` (public) -- extra

Request `{ "domainBlock": "5", "leaf": { "batchId", "payee", "amount", "salt" }, "proof": [..] }` ->
`{ "valid": true, "stateRootOnChain": "0x..", "leafHash": "0x..", "domainBlock": "5" }`. Reads `Hub.results` on Monad.
A tampered proof or altered amount returns `valid: false`.

### `GET /api/withdrawals/:address` (self, or a granted reader)

```json
{ "address": "0x..", "withdrawals": [ {
  "kind": 1, "payee": "0x..", "token": "0xCd12..", "amount": "1000000000", "nonce": "0", "salt": "0x..",
  "status": "claimable", "domainBlock": "6", "monadBlock": "76876612", "leafHash": "0x..", "proof": ["0x.."],
  "resultTx": "0x..", "claimTx": null } ] }
```
Kind 2 (swap) entries carry `tokenIn, tokenOut, amountIn, minOut, maxFee` instead of `token, amount`, plus
`claimAsInput: { to: <hub>, function: "claimAsInput", note, args: { domainBlock, w: {payee, tokenIn, tokenOut,
amountIn, minOut, maxFee, nonce}, salt, proof } }` -- the payee sends `Hub.claimAsInput(domainBlock, w, salt, proof)`
from their own Monad account (payee-only; they need MON for gas, the relayer cannot send it).
`status`: `burned` (executed privately, result not yet posted), `posted` (post tx sent, not yet confirmed),
`claimable` (Hub accepted the root, leaf unclaimed), `claimed`. Only the current epoch is listed.

### `POST /api/claim` (public; the terms are proven by the leaf)

Request `{ "address": "0x..", "nonce": "0" }`. The relayer calls `Hub.claim` (kind 1) or `Hub.claimSwap` (kind 2),
after one `eth_estimateGas` that decodes any revert. Response:

```json
{ "tx": "0x..", "kind": "claimSwap", "gasLimit": "400000", "received": { "token": "0x1F2C..", "amount": "1009445000" },
  "feePaid": "50000", "relayer": "0x350A..", "monadBlock": "76876650", "payee": "0x..", "nonce": "0", "domainBlock": "7" }
```
Errors: 404 `not_found`; 409 `not_posted`; 409 `claim_in_progress`; 409 `claim_reverted` with
`"revert": { "name": "Slippage" | "AlreadyClaimed" | "InvalidProof" | "FeeAboveMax" | "OutputBelowMin" | ..., "args": [..] }`.
Claims are never retried blindly. After `Slippage`, the payee uses `claimAsInput`.

### `POST /api/quote` (public)

Request `{ "tokenIn", "tokenOut", "amountIn": "1000000000", "slippageBps": 50 }` ->

```json
{ "tokenIn": "0x..", "tokenOut": "0x..", "amountIn": "1000000000", "quote": "999500000", "poolFeeBps": 5,
  "relayerFee": "50000", "expectedNet": "999450000", "slippageBps": 50, "suggestedMinOut": "994452750",
  "suggestedMaxFee": "50000", "simulated": true, "venue": "MockSwap" }
```
`quote` = `MockSwap.quote` (after the 5 bps pool fee). `expectedNet` = quote - flat relayer fee. `suggestedMinOut` =
`expectedNet x (1 - slippage)`: this is the value for `requestSwapWithdrawal(amount, tokenOut, minOut, maxFee)`
(the contract requires `minOut` to be received AFTER the fee). Only tUSDC and tUSDT are accepted.

### Demo endpoints

- `GET /api/demo/accounts` (only if `DEMO_MODE=1`, else 404): `{ note, domainChainId, finance, approvers[3], auditor,
  payees[50], treasury, token }`, each account `{ address, privateKey }`. **Testnet demo keys only**; they sit in
  `operator/data/demo-accounts.json` (git-ignored) and hold no value.
- `POST /api/demo/reset` (admin): header `x-admin-token: <DEMO_ADMIN_TOKEN>` (or `Authorization: Bearer ..`). Pauses the
  operator, `evm_revert`s the private chain to the opening snapshot (re-snapshotting), bumps `epoch`, restores the mock
  rate to 1.0 and tops up the MainBridge escrow with `TestUSDC.mint` if earlier claims drained it below the opening supply.
  Hub counters on Monad are never touched. Returns `{ epoch, snapshotId, actions, status }`. 401 bad token, 503 if
  `DEMO_ADMIN_TOKEN` is unset, 409 `snapshot_lost` if anvil was restarted (run `pnpm bootstrap -- --force`).
  After a reset, receipts, payments and withdrawals of earlier epochs are no longer served, and every account's private
  nonce is back at its opening value (refetch `/api/nonce`).
- `POST /api/demo/mock-rate` (admin): `{ "rate": "900000000000000000", "tokenIn"?, "tokenOut"? }` (default
  tUSDC->tUSDT, scaled 1e18). Sends `MockSwap.setRate` as the deployer and waits for it; returns `{ tokenIn, tokenOut,
  rate, tx, monadBlock }`.

## 4. Errors

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `bad_request`, `ciphertext_too_large`, `bad_gas_limit`, `same_token`, `unsupported_token` | invalid input |
| 401 | `unauthorized` | missing/stale/invalid read signature or admin token |
| 403 | `denied` | the contract refused this read for the caller |
| 404 | `not_found` | unknown route, batch, payment, withdrawal |
| 409 | `claim_reverted` (+`revert`), `not_posted`, `claim_in_progress`, `no_rate`, `snapshot_lost`, `not_bootstrapped` | state conflict |
| 413 | `bad_request` | body over 400 KB |
| 502/504 | `relay_failed`, `tx_reverted`, `claim_timeout`, `timeout` | Monad side failed |
| 503 | `relayer_busy`, `admin_disabled` | |
| 500 | `internal` | unexpected |

## 5. Recipes

**Pay 50 people.** Finance: `Treasury.propose(payees[], amounts[], memoHash)` as an inner tx -> encrypt -> `POST
/api/submit` -> wait for the `domainBlock` event containing `id`. Two approvers: `Treasury.approve(batchId)` each
(batch id = `batchCount` after the proposal; read `/api/treasury`). The second approval executes the payout in the
same private block. One approval changes nothing. A payee then reads `/api/balance/:self`.

**Withdraw.** Payee: inner tx `DomainToken.requestWithdrawal(amount)` (to tUSDC) or
`requestSwapWithdrawal(amount, tokenOut, minOut, maxFee)` (to tUSDT; get `minOut` and `maxFee` from `/api/quote`).
After the `resultPosted` event for that domain block, `GET /api/withdrawals/:self` shows `claimable`;
`POST /api/claim` pays on Monad. A second claim is rejected (`AlreadyClaimed`).

**Denied moment.** As payee A call `GET /api/balance/<payee B>` -> 403 `denied`.

**Public view.** `GET /api/public/hub-events` plus the explorer links.

## 6. Private chain and operator facts

- anvil (Foundry 1.8.7) flags: `--network monad --chain-id 7777 --no-mining --order fifo --gas-price 0 --base-fee 0
  --accounts 1 --state data/anvil-state.json --state-interval 3`. Automine is off; the operator mines exactly one block
  per Monad block that carries a `Hub.Submitted` or `MainBridge.Deposit` event. Domain block numbers are the Hub's
  (`lastDomainBlock + 1`), independent of the private chain height.
- Per domain block: deposits are minted first (system relayer, `DomainToken.mintDeposit`), then each `Submitted`
  in log order: decrypt, check chain id and destination, `eth_sendRawTransaction`; any failure skips that tx only.
  One `evm_mine`. Then the two trees, 2-of-3 signatures (operator keys 1 and 2, falling back to 3),
  `Hub.postResult` from operator 1.
- `msgRoot` tree: kind-1 and kind-2 withdrawal leaves (OpenZeppelin leaf hashing, equal to `Hub.withdrawalLeaf` /
  `Hub.swapWithdrawalLeaf`, verified against the live Hub in `test/merkle-digest.test.ts`). Empty block -> `0x00..00`.
  Because the two kinds have different shapes, the tree is a `SimpleMerkleTree` over the already double-hashed leaves
  (OpenZeppelin `StandardMerkleTree` requires one uniform leaf type). Salts are 32 random bytes per leaf.
- Restart safety: before executing a block the operator persists `{domainBlock, monadBlock, privateHeadBefore}`; the
  record (leaves, roots, salts) is written atomically before anything is signed. On restart it rebuilds from the mined
  block or drops the pool and re-executes, and re-sends no post whose tx hash it already knows. Verified with two
  `kill -9` tests in the e2e (after mining; after signing).
- State lives in `operator/data/` (git-ignored): `state.json`, `private-chain.json`, `demo-accounts.json`,
  `blocks/<domainBlock>.json` (trees, salts, proofs, timings), `anvil-state.json`, logs.
- If the **anvil process** (not just the operator) is restarted, in-memory snapshots are lost: `reset` then returns
  409 `snapshot_lost`.

## 7. Measured timings

All numbers below were measured by `operator/scripts/e2e.ts` (final run: 74 checks passed, 0 failed, 22 result posts) on one
machine (public Monad testnet RPC about 200-250 ms round trip from it, measured with `curl`). Sample sizes are stated. Do not
quote them as chain speed: they are end-to-end latencies of this stack including the public RPC.

Method: every submission goes through `POST /api/submit`; times come from the WebSocket feed. "Included" = the operator
received the Hub log on its Monad WebSocket subscription (not `cast`-style receipt polling). Monad blocks arrive about every
0.3-0.4 s (6 `newHeads` notifications on the public WS, gaps 222-374 ms, one 6-sample check; PRD 7.1 measured ~315 ms over 200 blocks).

**10 sequential single-tx submissions** (`DomainToken.setPayoutPreference`, one per Monad block, nothing else running):

| Stage | median | p95 | min | max |
|---|---|---|---|---|
| API receipt -> included on Monad | 571 ms | 970 ms | 450 ms | 970 ms |
| included -> executed on the private chain | 162 ms | 252 ms | 143 ms | 252 ms |
| **submission -> domain executed** | **747 ms** | 1151 ms | 606 ms | 1151 ms |
| executed -> `postResult` confirmed on Monad | 780 ms | 1139 ms | 615 ms | 1139 ms |
| **submission -> result posted** | **1523 ms** | 2147 ms | 1326 ms | 2147 ms |

With n=10 the nearest-rank p95 is the maximum sample, so it is a rough tail indicator, not a tight estimate. All 20 submissions in the
run (10 above plus the batch, approvals, withdrawals; n=20): submission -> executed median 766 ms, p95 1151 ms, max 1540 ms;
submission -> posted median 1523 ms, p95 2284 ms, max 2326 ms. In earlier e2e runs (before two latency fixes: a duplicate
`eth_getLogs` and per-block RPC reads were removed) submission -> posted was about 1.5x slower (median 2224 ms, n=10); occasional outliers of 3-4 s
on one stage also occurred when the public RPC stalled (one 8.1 s submission-to-posted in an earlier run). Those runs are
not part of the table.

Where the time goes (about): `included -> executed` is dominated by one `eth_getLogs` round trip to Monad (authoritative
event read for the block) because the node is about 200 ms away; the private-chain work itself is 21-28 ms per block
(n=20, median 23 ms, p95 28 ms, max 64 ms) and includes sending the txs and mining one block.

**Private-chain cost of a 50-payee batch, Monad mode vs plain anvil** (`scripts/bench-anvil.ts`, 2 fresh anvil instances
per mode, 30 timed runs each after 2 warm-ups, wall clock from `eth_sendRawTransaction` to the end of `evm_mine`,
state reverted between runs):

| | Monad mode (`--network monad`) | plain mode |
|---|---|---|
| `approve` executing 50 transfers, median / p95 | 4.9 ms / 5.5 ms and 4.8 ms / 6.1 ms (two instances) | 4.9 ms / 6.1 ms and 4.6 ms / 5.8 ms |
| `propose` (50 payees), median | 5.5 ms and 5.0 ms | 5.2 ms and 5.0 ms |
| gas used, `approve` executing 50 payments | 1,895,314 | 1,759,726 |
| gas used, `propose` 50 payees | 3,399,674 | 3,588,151 |

Conclusion from these samples: Monad mode costs no measurable time versus plain mode (difference within run-to-run
noise); gas accounting differs by under 8 %. Monad mode (`--network monad`) was accepted and runs with the 30,000,000
block gas limit.

**Monad cost per operation** (limit-billed; measured balance deltas and gas formulas): `postResult` limit 160,000 gas
(`eth_estimateGas` for it: 137,856) is about 0.016 MON at the observed 102 gwei gas price (PRD 7.1's ~0.03 MON came from a looser limit);
one full e2e run spent 0.356 MON on operator 1 (22 posts) and about 0.2 MON on the relayers.

