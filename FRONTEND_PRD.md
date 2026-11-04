# Whale: Frontend PRD

> **Whale** - Institutional funds privacy at ease.

Companion to [PRD.md](PRD.md). This document is the single source of truth for the web app. It is built in a
separate session; the backend session publishes the exact API in `docs/API.md` (see section 9).

---

## 1. Principles

1. **Quiet and exact.** Flat surfaces, hairline borders, one accent colour. No glass, blur, gradients, glows or
   decorative shadows.
2. **One job per screen.** Every page has one primary action. If a screen has two, split it.
3. **The demo is the product.** Every step is a click. Nothing requires typing during the demo. Every number on
   screen is measured or read from the chain, never hard-coded.
4. **Privacy is visible.** Where data is hidden, show a labelled placeholder (`Private`), never an empty cell.
5. **Honest.** State is real or clearly labelled `Simulated` (for example the mock swap rate).

## 2. Stack

| Concern | Choice |
|---|---|
| Framework | Next.js (App Router), TypeScript, React |
| UI components | **coss ui** (React, built on Base UI, styled with Tailwind CSS; formerly Origin UI; early-stage, Base UI is in beta so breaking changes are possible) |
| Styling | Tailwind CSS with CSS variables for the tokens in section 3 |
| Chain reads/writes | viem |
| Icons | Lucide, 16 px, stroke 1.5 |
| Fonts | Inter (UI), JetBrains Mono (addresses, hashes, amounts in tables) |

**To verify at build time (not verified by the PRD author):** coss ui install method and CLI/registry commands
(docs at coss.com/ui; the domain was unreachable from the PRD session), the exact component names available, and
whether each needed component exists. Where coss ui lacks a component, build it with Base UI primitives in the same
token system. Pin versions; do not use `latest`.

## 3. Design tokens

### 3.1 Colour (single light theme)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAFAFA` | Page background |
| `--surface` | `#FFFFFF` | Cards, tables, inputs |
| `--surface-muted` | `#F4F4F5` | Table header, chips, disabled |
| `--border` | `#E4E4E7` | All 1 px borders and dividers |
| `--border-strong` | `#D4D4D8` | Input hover, focused container |
| `--text` | `#18181B` | Primary text |
| `--text-muted` | `#71717A` | Labels, secondary text |
| `--text-faint` | `#A1A1AA` | Placeholders, hints |
| `--accent` | `#1D4ED8` | Primary buttons, links, focus ring, active nav |
| `--accent-hover` | `#1E40AF` | Primary hover |
| `--accent-soft` | `#EFF4FF` | Selected row, active nav background |
| `--success` / `--success-soft` | `#15803D` / `#F0FDF4` | Executed, verified |
| `--warning` / `--warning-soft` | `#B45309` / `#FFFBEB` | Pending, simulated |
| `--danger` / `--danger-soft` | `#B91C1C` / `#FEF2F2` | Denied, failed |
| `--private` | `#52525B` on `#F4F4F5` | The `Private` placeholder chip |

Text on `--surface` must meet 4.5:1 contrast (all pairs above do). The accent is the only chromatic colour outside
status colours.

### 3.2 Type

| Role | Size / line height | Weight | Notes |
|---|---|---|---|
| Display (one big number per page) | 40 / 48 | 600 | `font-variant-numeric: tabular-nums`, letter-spacing -0.02em |
| Page title | 24 / 32 | 600 | |
| Section title | 16 / 24 | 600 | |
| Body | 14 / 20 | 400 | Default |
| Label | 13 / 16 | 500 | Muted colour |
| Caption | 12 / 16 | 400 | Muted colour |
| Mono | 13 / 20 | 400 | Addresses, hashes, token amounts in tables |

Numbers in tables and stat blocks use tabular figures and are right-aligned. Addresses show `0x1234…abcd`
(first 6, last 4) with the full value on hover/copy.

### 3.3 Space, size, shape

Base unit **4 px**. Allowed spacing values: 4, 8, 12, 16, 24, 32, 48, 64. Nothing else.

| Item | Value |
|---|---|
| App shell | Sidebar 232 px, topbar 56 px, content max-width 1120 px, centred, page padding 32 px (24 px below 1024 px) |
| Card | Padding 24 px, radius 12 px, border 1 px `--border`, no shadow |
| Gap between cards | 16 px; between page title and first card 24 px; between sections 32 px |
| Button | Height 36 px, padding-x 16 px, radius 8 px; large (primary CTA in the demo) 44 px, padding-x 24 px |
| Input / select | Height 40 px, padding-x 12 px, radius 8 px, border 1 px `--border` |
| Table | Header 40 px (`--surface-muted`, label type); row 48 px; cell padding-x 16 px; 1 px row dividers; no zebra |
| Chip / badge | Height 24 px, padding-x 8 px, radius 6 px, caption type |
| Focus ring | 2 px `--accent`, 2 px offset, on every interactive element |
| Icon | 16 px inline, 20 px in nav |

Shadow: none, except popovers and dialogs: `0 8px 24px rgba(24,24,27,0.08)`. Overlay `rgba(24,24,27,0.4)`, no blur.

### 3.4 Motion

150 ms ease-out for hover, focus and chip changes. 200 ms for dialogs. Balance counters may tick at 60 fps.
No page transitions, no bouncing, no parallax. Respect `prefers-reduced-motion`.

## 4. App shell

```
┌────────────┬──────────────────────────────────────────────────────┐
│  Sidebar   │ Topbar 56:  [page title]        [role switch] [timer]│
│  232 px    ├──────────────────────────────────────────────────────┤
│  Whale     │                                                      │
│  nav       │  Content (max 1120, padding 32)                      │
│            │                                                      │
│  ──────    │                                                      │
│  network   │                                                      │
└────────────┴──────────────────────────────────────────────────────┘
```

- **Sidebar:** wordmark `Whale` (16/24, 600) at top with 24 px padding; below it the tagline in caption type.
  Nav items 36 px high, 8 px radius, 12 px padding-x, icon + label. Active item: `--accent-soft` background, accent text.
  Items depend on the role (section 5). Footer: network chip `Monad Testnet` with a 8 px status dot (green = reachable).
- **Topbar:** page title left; right side holds the **role switcher** (select, 160 px) and the **latency chip**.
- **Role switcher:** demo-only. Switching role swaps the nav and the active demo account. Label it `Demo role`.
- **Latency chip:** shows `Confirmed in 0.84 s` for the last submission. Value comes from real timestamps
  (API event feed). Before any submission: `-`.

## 5. Pages

Roles: **Finance**, **Approver**, **Payee**, **Auditor**, **Observer**.

### 5.1 Finance - `/payouts`

Nav: Payouts, Treasury.

1. **Header row:** title `Payouts`; right-aligned primary button `New payout` (large).
2. **Treasury stat card** (full width): label `Treasury balance`, display number (token amount, 2 decimals),
   caption `Private. Visible to Finance, Approvers and Auditors.` Right side: secondary button `Deposit`.
3. **Batches table:** columns `Batch`, `Payees`, `Total`, `Approvals`, `Status`, `Created`. Status chips: `Pending`
   (warning), `Executed` (success), `Cancelled` (muted). Approvals shown as `1 / 2` with two 8 px dots.
   Empty state: `No payouts yet.` + `New payout` button.

**New payout** (dialog, 640 px wide, padding 24):
- Step 1: dropzone (height 160, dashed 1 px `--border-strong`) `Drop a CSV or choose a file`; link `Use demo file (50 payees)`.
  CSV columns: `address,amount` (header required). Max 100 rows.
- Step 2: preview table (max 8 visible rows, scroll), summary line `50 payees · 12,450.00 tUSDC`, inline validation
  errors per row (danger text, 12 px). Memo input (optional).
- Footer: `Cancel` (secondary) and `Propose payout` (primary). On submit: encrypt in the browser, send, show the
  confirmation row in the table with a `Pending` chip. No success toast; the table row is the confirmation.

### 5.2 Approver - `/approvals`

Nav: Approvals.

- Title `Approvals`. Table of pending batches: `Batch`, `Payees`, `Total`, `Proposed by`, `Approvals`, action column.
- Row action: primary `Approve` button (36 px). After approving: button becomes a `Approved by you` chip.
  The approval that reaches the threshold flips the row to `Executed` within the same view and plays the 150 ms chip change.
- Detail panel (right drawer, 480 px): batch summary and payee table (Approvers are allowed to see it).
- Info line under the title: `2 of 3 approvers required. Finance cannot approve its own batches.`

### 5.3 Payee - `/balance`

Nav: Balance, Withdraw.

- **Balance card:** label `Your balance`, display number, caption `Private. Only you can see this.`
- **Payments table:** columns `Date`, `Batch`, `Amount`. Own rows only. Empty state: `No payments yet.`
- **Withdraw** (`/withdraw`), a single centred card (max-width 480):
  1. `Amount` input with `Max` link.
  2. `Receive as` select: `tUSDC` / `tUSDT`. Selecting `tUSDT` reveals the swap summary block (8 px radius,
     `--surface-muted`, padding 16): rows `Rate` (with a `Simulated` warning chip on testnet), `Pool fee`,
     `Network fee` (flat, paid in the received token, capped by `Max fee`), `You receive` (bold, with
     `Minimum` below it).
  3. `Slippage` segmented control `0.5% · 1% · 2%` (default 1%) which sets `minOut`.
  4. Primary large button `Withdraw`.
  5. After submit, a vertical 3-step status list: `Burned in Whale` → `Result posted on Monad` → `Paid on Monad`
     with a link to the Monad explorer for the paid transaction.
  6. If the swap step fails: danger banner `Price moved beyond your limit.` with a secondary button
     `Withdraw as tUSDC instead` (the fallback; the payee may need MON for this path, state that in a caption).

### 5.4 Auditor - `/audit`

Nav: Audit.

- **Top row:** stat blocks (three, equal width, 16 px gap): `Total paid`, `Payees`, `Batches`.
- **Payments table:** full detail for authorised batches: `Batch`, `Payee`, `Amount`, `Status`, `Receipt`.
  Receipt column: `Verify` link button.
- **Verify receipt** (dialog, 560 px): shows the Merkle proof checked against the root accepted on Monad.
  Fields (mono): `State root`, `Message root`, `Monad block`, `Leaf`. Result chip: `Verified on Monad` (success) or
  `Does not match` (danger). Include a `View on explorer` link.

### 5.5 Observer (split screen) - `/observer`

The public view and the role views side by side. Used for the demo's central moment.

- Two panes, 50 / 50, 1 px `--border` divider, each with a 40 px header.
- **Left pane `What the public sees` (Monad):** live list (newest first, row height 48) of Hub events: time, courier
  address, and the ciphertext as a truncated hex string (`0x04a1c9…e7`, mono, 24 chars). Footer caption
  `Amounts and recipients are not visible.` Each row has an explorer link.
- **Right pane:** a role view selected by a 3-way segmented control `Payee A · Payee B · Auditor`. Payee views show
  only that payee's amount. A `Try to read Payee B's balance` secondary button on Payee A's pane performs the real
  read and renders a danger chip `Denied`.
- Top of the page: the latency chip and a counter `Submissions: 50 · Confirmed: 50`.

### 5.6 Treasury (Finance) - `/treasury`

- Balance, deposit history (`Deposit`, `Amount`, `Time`, explorer link), and the `Deposit` dialog: amount input,
  primary `Deposit` button. Deposits are public on Monad; caption states that.

### 5.7 Demo controls

A collapsible bottom-right panel (240 px wide, 12 px radius, border, toggled with the `D` key, off by default):
`Reset demo`, `Load demo data`, and read-only `Operator status`. `Reset demo` calls the backend reset and reloads
the app. Never visible to the audience unless toggled.

## 6. Components and states (all from coss ui unless noted)

Button (primary, secondary, ghost, destructive), Input, Select, Segmented control, Table, Dialog, Drawer, Tabs,
Badge/Chip, Tooltip, Toast (used only for errors), Skeleton. Custom (Base UI + tokens): Dropzone, Stat block,
Step list, Address (truncate + copy), Latency chip.

Every data view implements four states: **loading** (skeleton rows of the real row height), **empty** (one sentence +
the next action), **error** (danger-soft banner with `Retry`), **ready**.
Disabled controls use `--surface-muted` and `--text-faint`; never rely on opacity alone.

## 7. Content rules

- Sentence case everywhere. No exclamation marks. No emoji.
- Amounts: `12,450.00 tUSDC`; two decimals, thousands separators, token symbol after.
- Times: relative under 1 minute (`4 s ago`), otherwise `HH:mm`. Full ISO on hover.
- Hidden data uses the `Private` chip, never blank cells or asterisks.
- Errors say what happened and what to do next in one sentence. No stack traces or hex error codes in the UI.
- Do not claim speed, compliance or security properties. Show measured values only.

## 8. Accessibility and responsiveness

- Keyboard reachable everywhere; dialog focus trap; Escape closes dialogs and drawers.
- Minimum target size 36 px. Contrast per section 3.1.
- Designed for 1440 × 900 projection first, then 1024 and up. Below 1024 px the sidebar collapses to a 56 px icon rail.
  No mobile layout is required for the demo.
- Minimum text size on the projected screens is 14 px; the demo toggle can raise root font size to 16 px.

## 9. Data contract

The frontend never talks to the private chain directly. It uses only:

- the backend HTTP API and WebSocket event feed, documented by the backend session in **`docs/API.md`**
  (endpoints for submit, authenticated reads, receipts, public view, reset),
- the Monad testnet via viem for deposits and explorer links (`deployments/monad-testnet.json` holds addresses,
  chain config and the operator encryption public key).

Browser-side duties: build the signed domain transaction, encrypt it to the operator public key published on the
Hub, sign read requests (timestamped message), and never log or persist private keys. Demo accounts and keys come
from a git-ignored env file or a demo-keys endpoint, never from source.

## 10. Acceptance (frontend)

1. The 3-minute demo script in PRD section 4 runs with clicks only.
2. The split screen shows real Hub events on the left and a real `Denied` on the right.
3. Every screen implements loading, empty, error and ready states.
4. No colour, spacing or radius value outside sections 3.1 and 3.3 appears in the code.
5. Lighthouse accessibility score of 95 or higher on each page.
