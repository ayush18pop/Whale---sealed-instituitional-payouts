# Whale: Backend spec (operator, proxy, relayer, API)

Read first: `PRD.md` (sections 2, 6, 6.1, 7, 8), `deployments/monad-testnet.json`, and the contracts in
`contracts/src/` plus their tests. This file is the build brief for the backend. The frontend is built in a
separate session and depends on the API you document in `docs/API.md`.

## 0. Rules of engagement

1. **Do not assume. Verify.** For every library (viem, eciesjs, @openzeppelin/merkle-tree, the HTTP framework,
   ws, anvil flags) read its current docs/README/types in `node_modules` or the web before using an API. If a
   behaviour is unverified, say so in code comments and in your final report.
2. **Scope.** You own `operator/` and `docs/API.md`. Do **not** edit `contracts/`, `web/`, `PRD.md`,
   `FRONTEND_PRD.md`, `deployments/`. If a contract change is required, **stop and report** the exact change and
   why; do not edit contracts.
3. **Secrets.** Keys live in `../.env` (git-ignored; names in section 2). Never print, log, commit or embed a
   private key. Demo keys you generate go in a git-ignored file under `operator/data/`.
4. **Git.** Commit locally in logical commits with the trailer
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. **Do not push.** Before each commit confirm no key
   material is staged.
5. **Measured numbers only.** Any speed figure you report must come from a measurement you ran. State method and
   sample size. Do not extrapolate.
6. **Testnet cost awareness.** Operator 1 holds ~2 MON; each `postResult` costs about 0.03 MON because Monad bills the
   gas **limit**. Keep any e2e run under ~30 on-chain result posts. Public RPC limit: 50 rps (25 rps for `eth_call`).
7. Node 20 is installed (`node -v` = v20.x), plus npm, pnpm and bun. Use Node 20 + TypeScript (ESM) + pnpm.
8. Finish with a report: what works, what you measured, what you could not verify, what is cut.

## 1. System recap

```
Browser --signed+encrypted inner tx--> POST /api/submit --> Relayer --Hub.submit(ct, gasLimit)--> Monad
Operator: watches Monad (Hub.Submitted, MainBridge.Deposit)
          -> mints deposits, decrypts + executes txs on a private anvil (chain 7777), mines ONE block
          -> builds Merkle trees, signs (2-of-3), Hub.postResult
Proxy/API: authenticated reads from the private chain. Relayer also submits claims on Monad.
```

Contracts (see `contracts/src`): Monad side `Hub`, `MainBridge`, `MockSwap`, `TestUSDC`, `TestUSDT`; private side
`DomainToken` (pUSDC, 6 decimals) and `Treasury`. Monad deployment is already live (addresses in
`deployments/monad-testnet.json`). **You deploy the private-side contracts** to your local anvil.

## 2. Configuration

`../.env` (git-ignored) already contains: `MONAD_TESTNET_RPC`, `DEPLOYER_PRIVATE_KEY`, `OPERATOR_PK_1..3` and
`OPERATOR_ADDR_1..3`, `RELAYER_PK_1..2` and `RELAYER_ADDR_1..2`, `SYSTEM_RELAYER_PK` and `SYSTEM_RELAYER_ADDR`,
`ENC_PRIVATE_KEY`, `ENC_PUBLIC_KEY` (65-byte uncompressed secp256k1, `0x04...`, also published on `Hub`).
Use WebSocket `wss://testnet-rpc.monad.xyz` for subscriptions, HTTP for calls, fallback RPCs listed in PRD 7.

Add your own variables to `operator/.env.example` (committed, no secrets): ports, `DEMO_MODE`, `DEMO_ADMIN_TOKEN`,
private anvil port, data dir.

## 3. Private chain (anvil)

One-time `bootstrap` command and a long-running `anvil` managed by the operator process (or a documented script).

- Required behaviour: chain id **7777**; **automine off** so the operator mines exactly one block per Monad block;
  FIFO transaction ordering; **gas price 0 and base fee 0** so domain users never need a native balance; Monad EVM
  rules if the flag works (`anvil --network monad`, PRD D2). **Verify the exact flags with `anvil --help`** and
  record what you used. Measure the cost of Monad mode versus plain mode for a 50-payee batch and report it.
- Deploy `DomainToken(systemRelayer = SYSTEM_RELAYER_ADDR, monadToken = TestUSDC address)` and
  `Treasury(token, financeLead, approvers[3], threshold 2)`. Use `forge build` artifacts in `contracts/out/`
  (re-run `forge build` in `contracts/`; do not edit contracts).
- Give the system relayer an anvil native balance (`anvil_setBalance`) only if needed; with gas price 0 it may not be.
- **Demo accounts** (generated once, keys in `operator/data/demo-accounts.json`, git-ignored): `finance`,
  `approver1..3`, `auditor`, 50 `payee` accounts. Finance calls `Treasury.setAuditor(auditor, true)`.
- **Opening position:** fund the Treasury by a real Monad deposit: `TestUSDC.mint` -> `MainBridge.deposit(token, amount,
  domainRecipient = Treasury address)` from the deployer (it holds MON), then let the operator mint it. Then take an
  `evm_snapshot` named opening. `reset` reverts to it. Domain block numbering (Hub) is independent of the private
  chain's block height, so revert is safe; withdrawal leaves carry a random salt so re-used nonces never collide.

## 4. Formats the contracts require (verify against the Solidity, do not trust this text blindly)

### 4.1 Inner transaction and encryption
- The browser builds a normal signed EVM transaction for chain id 7777 (legacy or EIP-1559, gas price 0), to
  `DomainToken` or `Treasury`.
- Plaintext to encrypt = the signed raw transaction bytes. Encrypt with **ECIES on secp256k1** to `ENC_PUBLIC_KEY`.
  Choose a maintained library that works in **both Node and the browser** (candidate: `eciesjs`; verify it, its
  defaults, and its ciphertext layout). Fix the exact library, version and options and write them in `docs/API.md`
  under "Crypto spec" so the frontend matches byte for byte. Provide a round-trip test and a shared module
  `operator/src/crypto.ts` the frontend can copy.
- `Hub.submit(bytes ciphertext, uint256 gasLimit)`; `gasLimit` = the inner transaction's gas limit; max ciphertext
  65 536 bytes; max gas limit 30 000 000.

### 4.2 Result digest and signatures
- `Hub.resultDigest(domainBlock, monadBlock, stateRoot, msgRoot)` is already EIP-191 wrapped. Sign that 32-byte value
  as a **raw** hash with each operator key (no second prefixing; verify with viem's raw-message signing).
- `postResult(domainBlock, monadBlock, stateRoot, msgRoot, bytes[] sigs)`: strictly consecutive `domainBlock`
  starting from `Hub.lastDomainBlock() + 1`; `monadBlock` > `lastMonadBlock` and <= current block; signatures from
  >= threshold (2) distinct operators **sorted by strictly ascending signer address**. Submitted from `OPERATOR_ADDR_1`.

### 4.3 Merkle leaves (OpenZeppelin StandardMerkleTree; leaf hash must equal the Solidity function)
- Kind 1 plain withdrawal, `Hub.withdrawalLeaf`: `[uint8 kind=1, address payee, address token, uint256 amount, uint256 nonce, bytes32 salt]`.
- Kind 2 swap withdrawal, `Hub.swapWithdrawalLeaf`: `[uint8 kind=2, address payee, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 maxFee, uint256 nonce, bytes32 salt]`.
- Both appear in one tree per domain block (`msgRoot`). **Write a test that proves your TS leaf hash equals the
  contract's** (call the deployed `Hub` view functions, or `cast`). `salt` = fresh 32 random bytes per leaf, stored.
- If the block has no withdrawals, use `msgRoot = 0x00..00`.
- `token`/`tokenIn` = `DomainToken.monadToken()`; the events `WithdrawalRequested` / `SwapWithdrawalRequested` on
  `DomainToken` supply the fields.

### 4.4 State root and payment receipts (operator design; the contract only attests the root)
`stateRoot` = root of a **ledger tree** (StandardMerkleTree) per domain block with leaves:
`[uint8 kind=10, uint256 batchId, address payee, uint256 amount, bytes32 salt]` for every `Treasury.Paid` event in
the block, plus one leaf `[uint8 kind=11, bytes32 privateBlockHash, bytes32 salt]`. A payee or auditor "receipt" is the
Merkle proof of their kind-10 leaf plus the `(domainBlock, monadBlock, stateRoot, resultTxHash)` the Hub accepted.
(PRD FR8.) Store trees and proofs persistently (`operator/data/`, git-ignored).

## 5. Operator loop (the core)

1. On start, read `Hub.lastDomainBlock()`/`lastMonadBlock()` and your persisted cursor; catch up by `eth_getLogs`
   in bounded ranges (respect rate limits), then switch to WebSocket subscriptions for `Hub.Submitted` and
   `MainBridge.Deposit` (and reconnect with backoff; never lose or duplicate an event).
2. Group events by Monad block, ordered by `(blockNumber, logIndex)`. For each Monad block with >= 1 event, derive
   exactly one domain block:
   a. apply deposits first (system relayer calls `DomainToken.mintDeposit(depositId, recipient, amount)`);
   b. for each `Submitted` in log order: decrypt; on any failure skip it (never abort the block); send the raw tx
      to anvil; a reverting inner tx is fine;
   c. mine **one** block;
   d. read new `WithdrawalRequested`/`SwapWithdrawalRequested`/`Paid` logs; build leaves, trees and roots (4.3, 4.4);
   e. sign with two operators (3 keys exist; use `OPERATOR_PK_1` and `_2`, fall back to `_3`), `postResult`.
3. **Idempotent and restart-safe.** A crash between mining and posting must not double-mint or skip a block; verify
   against chain state on restart. Test it by killing the process mid-flow.
4. **Timing.** Record per submission: API receipt time, Monad inclusion time (from the log's block), domain
   execution time, result-posted time. Emit them on the event feed. Measure inclusion latency with WebSocket
   subscriptions, **not** by polling `cast send`.

## 6. Relayer

- Accepts ciphertext, calls `Hub.submit` from a relayer EOA. Two relayer keys; round-robin.
- Track nonces locally (Monad best practice); concurrent submissions with `nonce + i`.
- **Gas:** do not call `eth_estimateGas` per request. Measure gas for `submit` across ciphertext sizes once, then
  use a tight formula with a safety margin (Monad bills the **limit**; PRD 7.1).
- **Reserve-balance budget:** a sender's in-flight gas fees must stay under its reserve; cap in-flight txs per relayer
  accordingly and queue the rest in memory (a simple in-memory queue is enough; no Kafka).
- Also submits claims: `Hub.claim` (kind 1), `Hub.claimSwap` (kind 2) from a relayer key (the relayer earns the flat
  fee). `Hub.claimAsInput` is payee-only: the API only returns the data a payee needs to send it themselves.
- Never retry a failed claim blindly; surface the revert reason (decode custom errors) to the API response.

## 7. API (REST + WebSocket) - document the final shape in `docs/API.md`

Pick a small, maintained HTTP framework (verify). JSON in/out, CORS enabled for `http://localhost:3000`, structured
errors `{ "error": "<code>", "message": "..." }`. Amounts are decimal strings of base units (6 decimals).

**Authentication for private reads.** Headers `x-address`, `x-timestamp` (unix seconds, +-60 s), `x-signature` =
EIP-191 signature by `x-address` over the message `whale-read:{timestamp}`. Missing/invalid -> 401; valid but not
permitted -> **403 `denied`** (this is the demo's "Denied" moment and must come from a real policy check, not a stub).
Never expose the private chain's raw RPC. All reads to the private chain are made by the server with `from` set to the
verified address (the contracts enforce the policy in-contract; the API must not bypass it by using a privileged `from`).

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/status` | none | domain and Monad heads, last result, contract addresses, tokens, swap config (rate, fees, `simulated: true`), operator status, demo mode |
| `GET /api/crypto` | none | encryption public key and scheme parameters |
| `POST /api/submit` `{ciphertext, gasLimit}` | none | relayer submit; returns `{id, hubTx, receivedAt}` |
| `GET /api/events` (WebSocket) | none | `submitted`, `included`, `domainBlock`, `resultPosted`, `claimed` events with timing fields in ms |
| `GET /api/public/hub-events?limit=` | none | recent `Hub.Submitted` events as the public sees them (courier, gasLimit, truncated ciphertext, explorer link) |
| `GET /api/balance/:address` | self, or reader | private token balance; 403 for others |
| `GET /api/payments/:address` | self or staff | that payee's payments (batch id, amount, time) |
| `GET /api/treasury` | staff | treasury balance and counters |
| `GET /api/batches`, `GET /api/batches/:id` | staff | batch list/detail (payees, amounts, approvals, status) |
| `GET /api/batches/:id/payment/:payee` | payee or staff | one payee's amount |
| `GET /api/receipts/:payee/:batchId` | payee or staff | ledger-tree proof + accepted roots + result tx (4.4) |
| `GET /api/withdrawals/:address` | self | withdrawals with status `burned` / `posted` / `claimable` / `claimed`, with the leaf fields, salt and proof |
| `POST /api/claim` `{address, nonce}` | none (terms are proven by the leaf) | relayer calls `claim` or `claimSwap`; returns tx hash, fee paid, tokens received; surfaces `Slippage` etc. |
| `POST /api/quote` `{tokenIn, tokenOut, amountIn, slippageBps}` | none | `MockSwap.quote`, relayer fee, suggested `minOut` (net of fee), `simulated: true` |
| `GET /api/demo/accounts` | `DEMO_MODE=1` only | roles and demo keys (**testnet only**) for the frontend's role switcher |
| `POST /api/demo/reset` | `DEMO_ADMIN_TOKEN` | revert the private chain to the opening snapshot; keep Hub block counters; return a fresh status |
| `POST /api/demo/mock-rate` `{rate}` | `DEMO_ADMIN_TOKEN` | move the MockSwap rate to demonstrate slippage (calls `MockSwap.setRate` as the deployer) |

"Staff" = `Treasury.financeLead`, an approver, or an auditor (read from the contract). "Reader" = an address the
account granted via `DomainToken.grantReader`.

## 8. Tests and acceptance (map to PRD section 8)

Unit (vitest): crypto round-trip; TS leaf hashes equal the Solidity ones for kinds 1 and 2 (against the live `Hub`
views); digest signing and ascending-signer ordering accepted by a fork or live `postResult`; ledger-tree proofs verify;
auth header verification (valid, stale, wrong signer).

Integration (`operator/scripts/e2e.ts`, runnable, prints a timing report; stay under the testnet budget):
1. bootstrap private chain + demo accounts + opening snapshot (FR1);
2. finance builds a 50-payee batch, signs, encrypts, submits; the explorer-visible Hub event contains no plaintext (FR2);
3. one submission pays 50 payees after two approvals; one approval does not (FR3, FR4);
4. payee A reads own balance; payee A reading payee B gets 403 (FR5); a contract-originated read is denied (FR6);
5. results post in order with 2 signatures; a wrong block number is rejected (FR7);
6. auditor fetches a receipt that verifies against the root on Monad; a tampered proof fails (FR8);
7. a payee withdraws to tUSDC and is paid exactly once; a second claim is rejected (FR9);
8. a payee withdraws to tUSDT through `claimSwap`: receives >= `minOut`, relayer fee <= `maxFee` (FR12); moving the
   mock rate makes the swap fail and the fallback `claimAsInput` succeeds (FR13, FR14);
9. `reset` restores the opening position and a second full run behaves identically (FR10);
10. measured timing report (FR11): submission-to-domain-executed and submission-to-result-posted, median and p95 over
    >= 10 runs (state the sample size), plus private-chain execution time for a 50-payee batch.

## 9. Deliverables

`operator/` (source, scripts, tests, `.env.example`, README with run commands), `docs/API.md` (exact request/response
JSON for every endpoint above, the Crypto spec, auth scheme, WebSocket event shapes, error codes, demo-mode notes, and
the measured timings), local commits, and the final report from section 0.8. Cuts, if time runs short, in order:
single operator signature, operator-relayed claims without proofs, on-chain approval gate in the backend. Report any cut.
