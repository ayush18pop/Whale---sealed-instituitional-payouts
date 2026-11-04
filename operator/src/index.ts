import { ensureAnvil } from "./anvil.js";
import { Operator } from "./operator.js";
import { Relayer } from "./relayer.js";
import { startApi } from "./api.js";
import { API_HOST, API_PORT, DEMO_MODE } from "./config.js";

const anvil = await ensureAnvil();
console.log(`[whale] private chain: anvil ${anvil}`);
const op = new Operator();
await op.start();
const relayer = new Relayer();
await relayer.warm();
await startApi(op, relayer);
console.log(`[whale] API on http://${API_HOST}:${API_PORT}  (WebSocket /api/events)  demoMode=${DEMO_MODE}`);
process.on("SIGINT", () => { op.stop(); process.exit(0); });
process.on("SIGTERM", () => { op.stop(); process.exit(0); });
