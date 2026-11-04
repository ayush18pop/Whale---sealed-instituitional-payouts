import { spawn } from "node:child_process";
import { anvilArgs } from "../src/anvil.js";
spawn("anvil", anvilArgs(), { stdio: "inherit" }).on("exit", (c) => process.exit(c ?? 0));
