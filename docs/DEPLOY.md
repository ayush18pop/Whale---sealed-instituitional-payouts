# Deployment: Vercel frontend + local backend behind ngrok

Production frontend: **https://whale-web-five.vercel.app** (Vercel project `ayush18pops-projects/whale-web`, personal scope).
Backend: runs on the developer machine (`cd operator && pnpm start`, port 8787) and is exposed with `ngrok http 8787`.

## How the pieces connect (and why there are no CORS errors)
```
browser --> Vercel (Next.js server routes /api/backend/* and /api/feed) --> ngrok https tunnel --> operator API :8787
```
The browser only ever calls its own Vercel origin. The server routes call the tunnel and add the `ngrok-skip-browser-warning`
header themselves, so ngrok's warning page and the backend's CORS list never apply to browser traffic. The routes also refuse any
POST whose `Origin` differs from the site's own origin (403). The one direct browser call is the wallet's deposit to the Monad
RPC, which allows the Vercel origin (checked). The backend's `CORS_ORIGIN` (default `http://localhost:3000`) only matters for
someone calling the tunnel directly from a browser.

## Environment variables (Vercel, production)
| Name | Value | Notes |
|---|---|---|
| `WHALE_API_URL` | the current ngrok https URL, no trailing slash, no `/api` | **changes every time ngrok restarts** on the free plan |
| `WHALE_ENABLE_TEST_ACCOUNTS` | `1` | needed for the demo role switcher. It lets **any visitor fetch the testnet demo accounts' private keys** (mock tokens only). Set `0` to disable |

## When the ngrok URL changes (redeploy)
```
cd web
printf '%s' "https://NEW-URL.ngrok-free.app" | vercel env add WHALE_API_URL production --force
vercel deploy --prod --yes
```
Env changes only apply to a new deployment. To avoid this, claim the free static ngrok domain (dashboard, Domains) and run
`ngrok http --url=<your-domain> 8787` once; then `WHALE_API_URL` never changes.

## Verified on the live site (4 Nov 2026)
Home page 200 (public, no login wall); `/api/backend/status` returns live backend state through the proxy; unsigned private read 401;
**signed read of own balance 200 and of someone else's 403 `denied` (from the contract)**; live feed streams events; POST with a foreign
Origin 403; same-origin POST 200; Monad RPC CORS allows the site origin. The feed is a long-lived stream that Vercel ends at its function
limit; the page uses `EventSource`, which reconnects automatically.

## Operating notes
- The backend is on a laptop: if the machine sleeps or ngrok/`pnpm start` stops, the site shows "payment service unavailable".
- Only one operator instance may run with these keys (`operator/src/lock.ts` enforces it per machine). See `docs/UNISWAP.md` for the
  evidence that a second instance elsewhere has been posting with the same keys; it will disturb live runs until it is stopped.
- The live swap venue is the simulated `MockSwap` (see `docs/UNISWAP.md`).
