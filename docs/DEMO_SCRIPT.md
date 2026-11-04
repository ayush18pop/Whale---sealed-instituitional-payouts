# Whale: 3-minute demo script

> **Whale** - Institutional funds privacy at ease.

Total 3:00. Two people: **Speaker** (talks, never clicks) and **Driver** (clicks, never talks). A third person
watches the clock and holds the backup video. Every Driver action is a click; nothing is typed on stage.

## The shape

Aha first, then how. The audience sees a result they cannot explain, then the diagram explains exactly what they
just watched. Every diagram step is numbered to match something already on screen.

| Time | On screen | Speaker says | Driver does |
|---|---|---|---|
| **0:00-0:15** | Whale landing/payouts page, treasury balance visible | "We built a private payout layer for institutions, on Monad. Not an anonymity pool, not a mixer, no zero-knowledge. Institutions choose who sees what. Watch." | Nothing. Page is already open as Finance. |
| **0:15-0:40** | Finance: `New payout` -> `Use demo file (50 payees)` -> preview -> `Propose payout` | "One payout, fifty wallets." (then silence while it loads) | Click the three steps. |
| **0:40-0:55** | Switch role to Approver, click `Approve`; switch to a second approver, click `Approve`. Row flips to `Executed`. | "Two approvers required. Finance can't approve its own batch." | Two approvals via the role switcher. |
| **0:55-1:25** | **Split screen.** Left: what the public sees on Monad (one transaction, hex bytes). Right: Payee A shows only their own amount. | "That is everything the public can see: one transaction of encrypted bytes. No names, no amounts. And this is what Payee A sees: only their own pay." | Open Observer. Payee A tab. |
| **1:25-1:35** | Click `Try to read Payee B's balance` -> red `Denied` chip | "And if a colleague tries to look..." (pause on `Denied`) | One click. |
| **1:35-1:55** | **Excalidraw diagram**: browser, relay, tx builder, Monad, operator (section 3). About 20 seconds. | "The Category Labs paper on Monad Private Settlement Domains came out yesterday. This is the idea." Then the three lines in section 3. | Point with the laser. |
| **1:55-2:15** | Back to the app: latency chip + counter, then Auditor tab: `Verify receipt` -> `Verified on Monad` | "Fifty payments, one transaction, paid and receipted on Monad in about a second and a half. Monad blocks are about 0.3 seconds. And the auditor can prove any payment against the root Monad accepted." | Two clicks. |
| **2:15-2:40** | *(optional, drop if running long)* Payee withdraws as `tUSDT`; `Simulated` chip visible | "Payees pick their currency. The swap venue is simulated on testnet; the path is real." | Withdraw click. |
| **2:40-3:00** | Closing slide: one line + roadmap | See section 4 | Nothing. |

## 1. What I changed from your outline, and why

1. **Result before explanation.** You suggested explaining while the transaction runs, or waiting then explaining.
   Better: trigger it, let the split-screen reveal land, then show the diagram. The diagram then *explains a result
   they already believe*, instead of asking for trust first.
2. **Skip the justification, keep the positioning.** One sentence ("not an anonymity pool, not a mixer, no
   zero-knowledge. Institutions choose who sees what") says what you are not and goes straight to the demo. Do not
   argue against Zcash, Tornado or ZK on stage; that invites a debate you do not need.
3. **The `Denied` moment is the proof of privacy.** It is the most memorable five seconds. Keep it, and make it a
   real read, not a mock.
4. **Lead with "50 payments, one transaction", not TPS.** It is true, visible and defensible. Do not state a TPS
   figure; nothing we measured supports one.
5. **Numbers only from measurements.** Section 2 lists which numbers we have and which come from the backend e2e run.
6. **One honest line near the end.** It pre-empts the hardest question (who can see the data?) and makes everything
   else more believable.
7. **The swap is optional.** It earns a sentence about currency choice but costs 15 seconds. Cut it first.

## 2. Numbers you may say

| Claim | Status | Source |
|---|---|---|
| Monad testnet block time about 0.3 s (measured ~315 ms) | **Measured** | 200 blocks in 63 s, 4 Nov; whole-second timestamps, so approximate. Say "about 0.3 seconds" |
| One transaction pays 50 payees | **Measured** | contract tests; ~1.9M gas on the private chain, under Monad's 30M per-transaction limit |
| Submission to executed privately: about 0.75 s. Submission to receipt posted on Monad: about 1.5 s | **Measured** | backend e2e, n=10 sequential runs, median (p95 1.15 s and 2.15 s), over the WebSocket feed from one machine on the public RPC. Say "median of ten runs" if asked |
| Cost per result post | **Measured** | ~0.016 MON (160,000 gas limit at 102 gwei); only quote if asked |
| TPS | **Do not claim** | no supporting measurement |

On the day, re-measure in rehearsal; if the latest median differs, say the new number. Never quote a number from a different machine or network.

## 3. Excalidraw diagram (about 20 seconds)

File: **`docs/whale-architecture.excalidraw`** (open at excalidraw.com, or drag it into the app). Handwriting font, five
boxes, four numbered arrows. Simple enough to follow cold, technical enough for a developer: it shows where encryption
happens, who signs what, and what Monad actually sees.

**How to present it:** point with Excalidraw's **laser pointer** (press `K`) from arrow 1 to arrow 4, about 5 seconds each:

| Arrow | Say | Matches in the live demo |
|---|---|---|
| 1 | "The browser signs the payout and encrypts it. Only ciphertext leaves." | The `Propose payout` click |
| 2 | "Our trusted relay queues the encrypted transactions in the order they arrive." | The left pane of the split screen |
| 3 | "The tx builder wraps each one in a Hub call, signs with our backend key, and submits it on Monad. Monad sees only bytes." | The explorer showing one transaction of hex |
| 4 | "Our operator decrypts it, runs it privately, and posts a receipt back." | `Verified on Monad` and each person's own view |

**Accuracy notes (so you do not over-claim on stage):** the relay **queues in arrival order**; it does not merge several
encrypted transactions into one Monad transaction (each is its own `Hub.submit`). The payroll batch of 50 payees is a
single *inner* transaction. The browser signs the payout; the backend signs the outer Monad transaction and pays the gas.
The operator is run by us in the demo, which the footer says.

Colours: **blue = public (Monad)**, **grey dashed = private**. The `0x9f3a...c1d2` entries in the relay box are
illustrative placeholders, not real hashes.

## 4. Closing (10 seconds)

> "It's a working version of the pattern from this paper. The operator is ours today, so privacy is from the public,
> not from the operator. Hardware attestation is the paper's own next step. Whale: institutional funds privacy at ease."

Never say: "first ever", "unhackable", "compliant", "zero knowledge", a TPS number, or anything about real money.

## 5. Likely questions, honest answers

| Question | Answer |
|---|---|
| Who can see the data? | The operator, today. The paper's next step is TEE attestation, which hides it from operators too. Auditors see only what the organisation grants. |
| Is this the real MPSD? | No. The paper has no public implementation we found. This is a working version of its pattern with our own operator. |
| Why not ZK / a privacy pool? | Different goal: institutions need a controlled audit view, and the payout must still settle against Monad's liquidity. |
| Are deposits and withdrawals private? | No. Amounts are public at the edges (the paper says so too). Everything inside is private. |
| Why Monad? | Every payment is posted as ciphertext, so it needs cheap, fast blocks and high throughput. |
| How fast? | Quote only the measured median from rehearsal, and the block time. |
| Is the swap real? | The path is real; the venue is a simulated pool on testnet, and the screen says so. |

## 6. Rehearsal and fallbacks

- Rehearse five full runs against the clock; the Speaker finishes inside 2:50 at least four times out of five.
- Pre-open every tab (Finance, both Approvers, Observer with Payees A and B, Auditor, the diagram). Pre-fund and
  `Reset demo` right before going on.
- Hard rule: if a step has not landed after 8 seconds, the clock-watcher says "switching to the recording" and the
  recorded run plays from that step. Record the backup video before the event.
- Keep the diagram identical to the one in the README so judges can look at it later.
- The line "the paper came out yesterday" is accurate only on 4 Nov 2026 (the paper is dated 3 Nov). Say the date on any
  other day.
