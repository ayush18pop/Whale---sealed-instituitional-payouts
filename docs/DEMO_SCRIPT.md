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
| **1:35-2:15** | **Excalidraw diagram**, revealed one numbered step at a time (section 3) | "The Category Labs paper on Monad Private Settlement Domains came out yesterday. This is how it works, and what you just watched." Walk steps 1-5, about 7 s each. | Advance the diagram. |
| **2:15-2:35** | Back to the app: latency chip + counter, then Auditor tab: `Verify receipt` -> `Verified on Monad` | "Fifty payments, one transaction, confirmed in `X` seconds. Monad blocks are about 0.3 seconds. And the auditor can prove any payment against the root Monad accepted." | Two clicks. |
| **2:35-2:50** | *(optional, drop if running long)* Payee withdraws as `tUSDT`; `Simulated` chip visible | "Payees pick their currency. The swap venue is simulated on testnet; the path is real." | Withdraw click. |
| **2:50-3:00** | Closing slide: one line + roadmap | See section 4 | Nothing. |

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
| "Confirmed in X seconds" (submit -> executed -> posted on Monad) | **Pending** | fill from the backend e2e timing report (median and p95, with sample size). Until then, say nothing |
| Cost per result post | Measured-ish | ~0.03 MON at the gas limit; only quote if asked |
| TPS | **Do not claim** | no supporting measurement |

On the day, replace `X` with the real median from the latest rehearsal and say "median over N runs" if asked.

## 3. Excalidraw diagram

File: **`docs/whale-architecture.excalidraw`** (open at excalidraw.com, or drag it into the app). 16:9-ish canvas,
large text, one picture with no jargon in the shapes.

**How to present it:** show the whole diagram at once and point with Excalidraw's **laser pointer** (press `K`) from
badge 1 to badge 5. This is more reliable on stage than revealing layers. Each beat is about 7 seconds.

| Badge | Say | What it matches from the live demo |
|---|---|---|
| 1 | "The finance team signs the payout and seals it in an encrypted envelope." | The `Propose payout` click |
| 2 | "Monad's mailbox puts it in order but can't open it. Our operator opens it and pays everyone, privately." | The left pane of the split screen: one transaction of bytes |
| 3 | "Only a receipt goes back to Monad. That is what the auditor can verify." | The `Verified on Monad` check |
| 4 | "Each employee sees only their own pay. The auditor sees what the company allows." | Payee A's view, and `Denied` for Payee B |
| 5 | "To get real money, an employee withdraws from the vault, once, with a proof." | The (optional) withdraw beat |

Colour code, so a first-time viewer reads it without help: **blue = public (Monad)**, **grey dashed = private**,
**green = employees**, dashed arrow = receipt or audit view. The footer states that the operator is ours today.

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
