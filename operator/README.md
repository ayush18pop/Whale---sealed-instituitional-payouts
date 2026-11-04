# Whale operator (backend)

Operator, relayer, private-chain manager and REST/WebSocket API for Whale. TypeScript, ESM, Node 20, pnpm.
The API contract for the frontend is in [`../docs/API.md`](../docs/API.md). The build brief is
[`../docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md).

## Layout

| Path | What |
|---|---|
| `src/crypto.ts` | ECIES encrypt/decrypt (copy this file into the browser) |
| `src/merkle.ts`, `src/digest.ts` | leaf hashes, trees (mixed leaf kinds), result digest, signature ordering |
| `src/operator.ts`, `src/monadWatch.ts` | the loop: watch Monad, mint deposits, decrypt + execute, mine, trees, sign 2-of-3, `postResult` |
| `src/relayer.ts`, `src/monadTx.ts` | `Hub.submit` / `claim` / `claimSwap` with local nonces and an in-flight fee budget |
| `src/api.ts`, `src/auth.ts` | HTTP + WebSocket API, read authentication |
| `src/demo.ts` | reset to the opening snapshot, move the mock swap rate |
| `scripts/bootstrap.ts` | one-time private chain bootstrap |
| `scripts/e2e.ts` | integration run + timing report |
| `scripts/bench-anvil.ts`, `scripts/measure-gas.ts` | measurements |
| `data/` (git-ignored) | demo keys, anvil state, operator state, per-block proofs, logs |

## Setup

```bash
cd operator && pnpm install
(cd ../contracts && forge build)          # artifacts used for the private-side deploy
pnpm tsx scripts/gen-abis.ts              # only if contracts changed
cp .env.example .env                      # then set DEMO_ADMIN_TOKEN; secrets stay in ../.env
```

## Commands

```bash
pnpm bootstrap                 # anvil chain 7777 + DomainToken/Treasury + demo accounts + opening deposit + snapshot
pnpm bootstrap -- --force      # wipe the private chain and redo (Hub counters on Monad are never reset)
pnpm start                     # operator + relayer + API (starts anvil detached if it is not running)
pnpm anvil                     # (optional) run anvil in the foreground instead
pnpm anvil:stop
pnpm test                      # unit tests (some read the live Hub on Monad testnet)
pnpm e2e                       # integration run; starts and kills the service itself (stop `pnpm start` first)
pnpm tsx scripts/bench-anvil.ts 30   # Monad mode vs plain mode, 50-payee batch
```

Costs on Monad testnet: each `postResult` bills its gas limit (160000 gas at ~102 gwei, about 0.016 MON); a
full `pnpm e2e` does about 25 result posts plus relayed submits and claims.
