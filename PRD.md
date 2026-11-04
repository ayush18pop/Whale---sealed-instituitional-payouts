# PRD: Whale

> **Whale** - Institutional funds privacy at ease.
> Frontend spec: [FRONTEND_PRD.md](FRONTEND_PRD.md). The earlier working title was "Sealed Payouts".

Private batch payouts for organizations, settled on Monad. Built as a first working demonstration of the
pattern in the Category Labs "Monad Private Settlement Domains" (MPSD) white paper (3 Nov 2026).

Status: draft v0.1. Every external fact below is tagged with its source. Anything not verified is in
section 11 (Open decisions) or section 12 (Unverified), not stated as fact.

---

## 1. One-line pitch

> A finance team pays 50 people in one transaction. The public sees nothing, each person sees only their
> own pay, and the auditor sees everything. It settles on Monad.

## 2. What this is and is not

**It is:** a "PSD-lite". We re-implement the paper's pattern (encrypted transactions sequenced on Monad,
executed privately by an operator, state roots attested back to a Hub contract, a lock-and-mint bridge)
with our own operator. It is a demo of the pattern, not the MPSD product.

**It is not:**
- The real MPSD. The paper describes a design; we found no implementation, testnet, SDK or deployed
  contracts in it (white paper, sections 1 and 5; confirmed by the Monad Devrel, per the team).
- Private from the operator. The operator sees all data (white paper 6.1: "a single rogue operator is
  sufficient to break the privacy"). TEE attestation is the paper's roadmap (6.3, 8).
- Compliant with anything. No KYC, tax, payroll-law or regulatory claims. Test tokens only.

## 3. Users and roles (demo accounts, no real login)

| Role | Can do | Sees |
|---|---|---|
| Finance lead | Upload a batch (CSV), propose a payout | Batch status, own proposals |
| Approver (x3 configured, 2 required) | Approve a proposed batch | The pending batch totals and payee count |
| Payee | View own pay, withdraw | Only their own balance and payments |
| Auditor | View the full batch table, verify a receipt | Everything the finance lead authorised |
| Public observer | Look at the Monad explorer | Ciphertext, the sender, the Hub address, later two hashes |

## 4. Demo (the product is the demo)

Target runtime 3:00. Every step is a click. No typing during the demo.

| Time | Screen | Claim shown |
|---|---|---|
| 0:00-0:20 | A public explorer view of a normal on-chain payroll wallet (mock, all salaries readable) | Today everyone sees everyone's pay |
| 0:20-0:50 | Finance lead loads a 50-payee CSV; two approvers click Approve | One batch, dual control (white paper 3: "dual-control sign-offs") |
| 0:50-1:30 | **Split screen.** Left: Monad explorer, one tx, random bytes. Right: payee views, each only their own line. One payee tries to read a colleague: **Denied** | Privacy + per-account reads (5.4) |
| 1:30-2:00 | On-screen timer and counter | Speed. **Only a number we measured is stated.** |
| 2:00-2:20 | Auditor view: full table, "Verify receipt" against the on-chain root | Anchored roots (5.2.3), non-repudiation (4.2) |
| 2:20-2:40 | Payee clicks Withdraw; tokens appear on Monad | Real settlement on a public chain (5.5.2) |
| 2:40-3:00 | Closing slide | Private, liquid, auditable. Honest limits stated. |

Demo-readiness requirements:
- One-click **Reset** returns every account and contract state to the opening position.
- All demo wallets pre-funded; relayer pays all Monad gas; the demo never shows a wallet prompt.
- A recorded backup video exists before the live run.
- Large type, readable from the back row; role switcher in the corner.

## 5. Scope

### In scope (MVP)
1. Deposit test stablecoin into the domain via the bridge.
2. Client-side encryption of transactions to the operator's public key; submission through the Hub.
3. Batch payout of up to 50 payees in one encrypted transaction.
4. Dual-control approval (2 of 3) enforced by a domain contract.
5. Per-account private reads through an authenticated RPC proxy.
6. Auditor role with full view and receipt verification against an on-chain root.
7. Withdrawal back to Monad with a Merkle inclusion proof and replay protection.
8. Public-view panel showing exactly what Monad shows.
9. Demo controls: role switcher, Reset, latency timer, tx counter.
10. **Payout in a chosen token (swap, now MVP):** a payee withdraws and receives `tUSDT` instead of `tUSDC`
    through claim-and-swap (section 6.1) with `minOut`, a capped flat relayer fee, and the fallback claim.
    The swap venue on testnet is `MockSwap` (labelled **Simulated** in the UI); a real DEX adapter is a stretch
    that needs a verified testnet pool.

### Later phases (not MVP)
- **Payout currency choice (MOVED INTO MVP, in-scope item 10):** each payee may state a preferred `tokenOut`. The manager funds one
  token; there is no hub-wide default currency. The swap happens at withdrawal through a `SwapAdapter`
  (section 6.1). Demo uses `MockSwap`; a real Uniswap adapter only after testnet availability is confirmed.
- **Recurring payouts (Phase 7, decision D6):** a backend scheduler auto-**proposes** each month's batch.
  Whether approvals are still required is open. Monad scheduled transactions are listed as forthcoming in the
  paper, so we do not rely on them.
- A cross-chain exit: CCTP/USDC is the only candidate (section 12). Not before the core demo works.
- Private oracle-priced pool.
- Passkey login (P256 precompile at `0x0100`, Monad docs "Differences").
- Key rotation / epochs.

### Out of scope
Compliance or legal claims, KYC, real money, TEE/ZK attestation, mainnet deployment, native-token payouts.

## 6. Architecture

```
 Web app (roles) --encrypted tx--> Relayer --Hub.submit(ciphertext)--> MONAD TESTNET (public)
                                                                         Hub, MainBridge, TestUSDC
 Operator <------ Hub.Submitted / Deposit events -----------------------+
   decrypt -> execute on private EVM (domain) -> one domain block per Monad block with domain txs
   -> salted state root + message root -> k-of-n signatures -> Hub.postResult
 Private RPC proxy <-- signed reads from the web app --> private EVM (domain)
```

Components:

| Component | Where | Responsibility |
|---|---|---|
| `Hub` | Monad | Emit encrypted submissions (no shared-slot writes), accept attested results strictly in block order, verify withdrawal proofs, prevent replays |
| `MainBridge` | Monad | Escrow tokens on deposit, release on a verified withdrawal |
| `TestUSDC` | Monad | Mock stablecoin with open mint (testnet USDC address not confirmed, see section 12) |
| `DomainToken` | Private EVM | Bridged representation; `balanceOf` restricted to owner or an allowed reader; bridge-only mint/burn |
| `Treasury` | Private EVM | Propose / approve (2 of 3) / execute a batch payout; emits withdrawal messages |
| Operator | Backend | Watch Monad, decrypt, execute, build roots and Merkle trees, sign, post results, store proofs |
| RPC proxy | Backend | Authenticated reads, allowlist of methods, auditor grants kept in private state |
| Relayer | Backend | Posts ciphertext to the Hub and pays Monad gas |
| Web app | Frontend | Roles, encryption in the browser, split-screen demo, timer, Reset |

White paper mapping: Hub (5.1), lock-and-mint bridge (5.5), lock-step block derivation (5.2.2), salted
Merklized roots (5.2.3), authenticated reads and policy enforcement (5.4), k-of-n committee attestation (6.1),
gas sponsorship via a different payer (5.2.1).

### Deliberate deviations from the paper (stated, not hidden)
- Operator is our own server; the paper's client is a Monad client extension.
- Policy enforcement is done inside the contracts (caller checks), not by an injected client call.
- Auditor grants are stored in private state, **not** on the Hub (the paper's global reader list is public, 5.4).
- Block cadence: one domain block per Monad block that has domain transactions (matches 5.2.2). Timestamps and
  randomness are not specified by the paper; we use block numbers and need no randomness.

### 6.1 What is public, who signs what, and the claim-and-swap flow (MVP)

**The Hub is public.** It is a contract on Monad: a mailbox and notary. It cannot decrypt anything. Only the
operator holds the decryption key. Balances live on the private EVM, not in the Hub. Encrypting a transaction
moves no money; money moves only through the public deposit into `MainBridge` and the proof-verified release.

| Signer | Signs | Purpose |
|---|---|---|
| Payer (manager) | The batch transaction, in the browser, then encrypts it there | Authorises the payments; the backend cannot invent them |
| Payee | Their withdrawal request inside the private chain: amount, `tokenOut`, `minOut`, `maxFee` | Fixes the terms of the payout |
| Operator committee | The `(blockNo, stateRoot, msgRoot)` result | Attests the private chain executed correctly |
| Relayer | The Monad transaction that calls the Hub | Pays MON gas |
| Hub / MainBridge / SwapAdapter | Nothing (contracts cannot sign) | Verify and execute inside the relayer's transaction |

If the relayer and operator are the same server, browser-side encryption protects against the public and Monad,
not against our own backend. This is disclosed.

**Claim-and-swap, one Monad transaction:**

```
Relayer -> Hub.claim(proof, terms) -> MainBridge.release -> SwapAdapter.swap -> DEX router
                                            then: pay relayer fee, send remainder to payee
```

1. Payee's private withdrawal request carries `tokenOut`, `minOut`, `maxFee`. These are part of the Merkle
   leaf, so the operator cannot change the recipient or the minimum.
2. The Hub verifies the proof against an accepted message root and checks replay protection.
3. `MainBridge` calls `SwapAdapter`, which approves the **exact** amount to the router and swaps. It reverts if
   output is below `minOut`.
4. A fee in the output token, capped at `maxFee`, repays the relayer. The payee never needs MON.
5. **Fallback:** if the swap reverts, the payee may claim the original token instead, because withdrawals must
   never be blockable (white paper 5.5.3).

| Cost | Paid by |
|---|---|
| DEX pool fee | Payee (taken from the swap) |
| Price movement | Payee, bounded by `minOut` |
| MON gas | Relayer up front (Monad charges the gas **limit**) |
| Relayer reimbursement | Payee, as a stablecoin fee deducted from the payout, capped at `maxFee` |

The MON-to-stablecoin conversion uses a **flat fee** in the demo (no live oracle). The swap itself is public on
Monad. A public swap can be sandwiched, hence `minOut`.

`SwapAdapter` is separate from the Hub so the Hub stays small and the DEX can be replaced. Only `MainBridge` may
call it. Demo: `MockSwap` with the same interface.

## 7. Verified platform constraints (from docs.monad.xyz)

| Fact | Value | Design consequence |
|---|---|---|
| Testnet chain ID | 10143 | Hub/bridge/token deploy here |
| Testnet RPC | `https://testnet-rpc.monad.xyz` (50 rps, 25 rps for `eth_call`/`estimateGas`), `https://rpc.ankr.com/monad_testnet`, `https://rpc-testnet.monadinfra.com` (20 rps, no batch) | Operator must use WebSocket subscriptions, not tight polling; keep fallback RPCs |
| Testnet WS | `wss://testnet-rpc.monad.xyz`, `wss://rpc-testnet.monadinfra.com` | Event feed for operator and UI |
| Faucet / explorers | `https://faucet.monad.xyz`; `https://testnet.monadvision.com`, `https://testnet.monadscan.com` | Funding; the public-view panel can embed or mirror MonadVision |
| Gas is charged on **gas limit**, not gas used | docs "Differences" | Hub must take a tight declared gas limit; relayer budget is limit-based |
| Reserve balance | 10 MON per EOA; in-flight gas of one sender is budgeted against it | A single relayer EOA cannot have many large in-flight txs. Use several relayer keys and small gas limits |
| No global mempool | docs "Differences" | Submissions are forwarded to upcoming leaders; do not assume instant inclusion visibility |
| Max contract size 128 KB | docs "Differences" | Not a constraint for us |
| Storage is paged (128 slots) | docs "Differences" | Keep related Hub state in consecutive slots |
| Full nodes do not serve arbitrary history | docs "Differences" | The operator indexes events itself and stores proofs locally |
| Block time ~300 ms, finality 600 ms (2 slots) | docs "Current facts", **mainnet** | These are mainnet figures. We **measure testnet** and state only that |
| Foundry >= 1.8.0 with `network = "monad"`; the old Monad fork is legacy | docs "Foundry" | Installed v1.8.7; project configured |
| Canonical testnet contracts | WMON `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`, Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`, Permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3` | Available if needed |

Correction to earlier chat: I quoted Monad block time as 400 ms. The docs state ~300 ms (observed, mainnet). Do not use 400 ms.

### 7.1 Measured on Monad testnet (4 Nov 2026)

| Measurement | Result | How / caveat |
|---|---|---|
| Block time | ~315 ms | 200 blocks in 63 s; timestamps are whole seconds, so approximate |
| Receipt `gasUsed` for `Hub.submit` | equals the gas **limit** (100000) | Confirms Monad bills the limit; use tight limits |
| `Hub.submit` send-to-receipt, 5 samples | median ~3.1 s (1.6-4.2 s) | **Not** chain speed: dominated by `cast send` polling for the receipt. Do not quote. Real inclusion latency is measured with a WebSocket subscription in Phase 2 |
| Deploy cost (3 contracts + wiring) | ~0.63 MON at ~102 gwei | |
| Gas, 50-payee batch on the private chain | `propose` 3.40M, executing `approve` 1.90M | backend gas measurement (Monad mode); both under the 30M limit. Earlier text said "~1.9M for a batch": that is only the executing approval |
| Submission to domain executed (n=10, sequential) | median 747 ms, p95 1151 ms | backend e2e over the WebSocket feed; p95 is the max sample at n=10; includes ~200-250 ms RPC distance from one machine |
| Submission to result posted on Monad (n=10) | median 1523 ms, p95 2147 ms | same run |
| Private-chain work per block (n=20) | median 23 ms, p95 28 ms | |
| `postResult` cost | gas limit 160,000, about 0.016 MON at 102 gwei | earlier estimate of ~0.03 MON was too high |
| Anvil Monad mode vs plain, 50-payee batch | no measurable difference (~4.9 ms median both) | resolves decision D2: use Monad mode |

Defensible speed figures now: block time about 0.3 s, and the measured submission-to-executed and submission-to-posted medians above (state n=10, one machine, public RPC). Do not state TPS.

## 8. Functional requirements

| ID | Requirement | Acceptance test |
|---|---|---|
| FR1 | Deposit: user deposits TestUSDC; the same amount is minted to their address in the domain | Domain `balanceOf` equals deposit; escrow on Monad equals total minted |
| FR2 | Submissions are encrypted client-side; the Hub event contains no plaintext | Decode the event: no addresses or amounts present |
| FR3 | One encrypted transaction can pay up to 50 payees | 50 balances updated after one Hub submission |
| FR4 | A batch executes only after 2 of 3 approvals | One approval: no change. Two: payouts execute |
| FR5 | A payee reads only their own balance | Same query from another account returns "denied" |
| FR6 | A contract cannot read someone else's balance | Test contract calling `balanceOf(victim)` reverts |
| FR7 | Results are accepted in block order with a valid k-of-n signature | Skipping a block number, or a bad signature, reverts |
| FR8 | Auditor can verify a receipt against the on-chain root | Proof verifies; a tampered proof fails |
| FR9 | Withdrawal pays out on Monad exactly once | A second claim of the same leaf reverts |
| FR10 | Reset restores the opening state | After Reset, a fresh run behaves identically |
| FR11 | The timer shows measured submit-to-confirmed latency | Value is computed from real timestamps, not hard-coded |
| FR12 | (MVP) Withdrawal with a swap pays the payee `tokenOut` | Payee receives >= `minOut`; relayer fee <= `maxFee` |
| FR13 | (MVP) A swap below `minOut` reverts | Move the mock price; claim reverts |
| FR14 | (MVP) Fallback claim in the original token works after a failed swap | Claim succeeds with `tokenIn` |
| FR15 | (MVP) `SwapAdapter` is callable only by `MainBridge` | Direct call from any other address reverts |

## 9. Non-functional requirements

- Demo must complete 5 consecutive times without manual intervention before the live run.
- No private key in the repo, the browser bundle or logs. Demo keys live in `.env` files that are git-ignored.
- Every claim shown on a slide is either measured or tagged as design-only.

## 10. Build phases and exit criteria

| Phase | Work | Owner | Exit criterion |
|---|---|---|---|
| 0 | Repo, toolchain, config, interfaces | Lead | `forge test` passes in Monad mode; funded deployer on testnet; `anvil --network monad` verified. **Done up to funding.** |
| 1 | Contracts: TestUSDC, MainBridge, Hub, DomainToken, Treasury + tests | Lead | All tests in FR6, FR7, FR9 green; deployed to testnet; addresses in `deployments.json`. **Status: code and 67 tests done (FR4-FR7, FR9 covered at contract level; a 50-payee batch executes in ~1.9M gas). **Deployed to Monad testnet on 4 Nov 2026** (TestUSDC, MainBridge, Hub; wiring read back on-chain). Addresses and config: `deployments/monad-testnet.json`.** |
| 2 | Operator core loop (watch, decrypt, execute, roots, post) | Backend subagent | A script submits an encrypted batch; balances and the posted root are correct. **Status: done; restart-safety tested with two kill -9 runs; e2e 74/74 checks on testnet** |
| 3 | RPC proxy, relayer, receipt endpoint, event feed | Backend subagent | FR5 and FR8 pass against the running service. **Status: done; API documented in `docs/API.md`** |
| 4 | Frontend: roles, split screen, timer, Reset (mock data first) | Lead / frontend | The demo script runs by clicking, against mocks |
| 5 | Integration and hardening | All | FR1-FR11 pass; 5 clean runs; backup video |
| 6+ | Stretch (section 5) | | Only after phase 5 |

Cut order if time runs short: (1) k-of-n signing -> single operator signature; (2) Merkle withdrawal proof ->
operator-relayed; (3) on-chain dual control -> backend-enforced.

## 11. Open decisions (need confirmation before Phase 1)

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Private chain: real `anvil` vs in-memory ledger | `anvil`: runs real EVM bytecode, so the contracts are the real thing. Fall back to a ledger only if throughput fails the spike |
| D2 | Run the domain's anvil in Monad mode (`--network monad`) or plain | Monad mode, to match the paper ("an extension of the Monad client"). Earlier I blamed Monad mode for slow tests; the real cause was `eth-rpc-url` in `foundry.toml` making forge call the public testnet RPC (slow, and HTTP 429 failures). With the URL removed the full suite (67 tests) runs in ~0.2 s. Still **measure anvil throughput in the Phase 2 spike** |
| D3 | Stablecoin: our `TestUSDC` vs Circle's testnet USDC | `TestUSDC` (open mint, no faucet dependency). Circle lists a Monad testnet USDC at `0x534b2f3A21130d7a60830c2Df862319e593943A3` (developers.circle.com, USDC contract addresses); more convincing but depends on a faucet |
| D4 | Who funds the deployer and relayers | A funded testnet key via `faucet.monad.xyz`. Needs the team's wallet |
| D5 | Role split between people / subagents | Contracts + frontend: lead. Operator + backend: Sonnet subagent (Opus only if it stalls) |
| D6 | Recurring payouts: do auto-proposed monthly batches still need 2 approvals? | Yes for the demo (keeps dual control visible); revisit later |
| D7 | Relayer reimbursement at claim: flat fee vs oracle-priced | Flat fee for the demo |

## 12. Unverified (do not state as fact until checked)

- Whether a USDC/USDT pool with liquidity exists on Monad **testnet** (mainnet Uniswap addresses are listed;
  testnet pools were not checked).
- **CCTP** (Circle's USDC burn-and-mint): Monad is a supported domain, ID 15; standard transfer works; Fast
  Transfer is N/A as a source; Monad testnet is supported except upfront fees (Circle "supported blockchains").
  Testnet CCTP contract addresses were **not found**.
- **CCIP** (Chainlink): a Monad Testnet directory page exists (router, chain selector, fee tokens LINK/WETH/WMON)
  but showed **no registered tokens** and the lane destinations were not confirmed. Do not plan stablecoin
  movement over CCIP on testnet.
- Which DEX router and version is deployed on Monad **testnet** and its call interface (v3 vs v4 differ; Permit2
  is a canonical testnet contract). Read the Uniswap docs when Phase 7 starts; do not write the adapter from memory.
- Testnet block time and finality (docs figures are mainnet).
- Any library API we have not yet read the docs for (viem WebSocket usage, ECIES library, Merkle tree library).
  Each is checked at the moment of use, in the phase that needs it.
- Monad agent skills: no official skill repository was found. Community skills exist
  (e.g. `therealharpaljadeja/monskills`, `0xinit/cryptoskills`) but are third-party and **not installed**.

## 13. Risks

| Risk | Mitigation |
|---|---|
| No real MPSD to build against | Say so in the pitch; label the operator as ours |
| Single anvil throughput | Phase 2 spike measures it; ledger fallback |
| Relayer hits the reserve-balance budget | Several relayer EOAs, small gas limits |
| Public RPC rate limits (50 rps) | WebSocket subscriptions, fallback RPCs |
| Testnet instability during the live demo | Backup video; Reset; local anvil-fork rehearsal path |
| Operator sees all data | Disclosed; TEE named as roadmap |
| Deposit and withdrawal amounts are public | Disclosed (white paper 1, 8) |

## 14. Success criteria

1. The 3-minute demo runs end to end with no manual fixes.
2. The split-screen moment is clear to a non-technical viewer in ten seconds.
3. Every number on screen is measured on testnet.
4. The pitch states what is real, what is simulated, and what the paper itself lists as future work.
