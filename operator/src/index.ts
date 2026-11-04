import { ensureAnvil } from "./anvil.js";
import { Operator } from "./operator.js";
import { Relayer } from "./relayer.js";
import { startApi } from "./api.js";
import { API_HOST, API_PORT, DEMO_MODE, SWAP_INFO, SWAP_VENUE } from "./config.js";
import { bridgeAdapter } from "./uniswap.js";
import { acquireInstanceLock } from "./lock.js";
import { DATA_DIR } from "./config.js";
import { join } from "node:path";

// Refuse to run a second instance with the same keys (see lock.ts). Must happen before anything touches the Hub.
const releaseLock = acquireInstanceLock(join(DATA_DIR, "operator.lock"));
process.on("exit", releaseLock);

const anvil = await ensureAnvil();
console.log(`[whale] private chain: anvil ${anvil}`);
const op = new Operator();
await op.start();
const relayer = new Relayer();
await relayer.warm();
await startApi(op, relayer);
const onChain = await bridgeAdapter().catch(() => null);
console.log(`[whale] swap venue: ${SWAP_VENUE} (${SWAP_INFO.adapter}); MainBridge.swapAdapter=${onChain}`);
if (onChain?.toLowerCase() !== SWAP_INFO.adapterAddress.toLowerCase()) console.warn(`[whale] WARNING: SWAP_VENUE=${SWAP_VENUE} but the bridge points at another adapter; quotes will not match execution`);
console.log(`[whale] API on http://${API_HOST}:${API_PORT}  (WebSocket /api/events)  demoMode=${DEMO_MODE}`);
process.on("SIGINT", () => { op.stop(); releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { op.stop(); releaseLock(); process.exit(0); });
