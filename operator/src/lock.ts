import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single-instance guard. Two operators with the same keys derive the same domain block with different random
 * salts, so their state roots differ and only the first postResult wins; the loser's post reverts and its local
 * record goes stale. This refuses to start a second instance on the same data directory.
 * A stale lock (dead pid, or a pid that is no longer this program) is taken over, so kill -9 and restarts work.
 */
export function isOurProcess(pid: number, procRoot = "/proc"): boolean {
  try {
    process.kill(pid, 0); // throws if the process does not exist
  } catch (e: any) {
    if (e?.code !== "EPERM") return false; // EPERM = exists but not ours to signal: treat as alive
  }
  try {
    const cmd = readFileSync(`${procRoot}/${pid}/cmdline`, "utf8");
    return cmd.includes("index.ts") || cmd.includes("index.js"); // guards against pid reuse by an unrelated process
  } catch {
    return true; // no /proc (non-Linux): fall back to "alive means ours"
  }
}

export function acquireInstanceLock(lockPath: string, pid = process.pid): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx"); // fails if it exists: the atomic part
      writeSync(fd, String(pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (readFileSync(lockPath, "utf8").trim() === String(pid)) unlinkSync(lockPath); } catch { /* already gone */ }
      };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const other = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(other) && other > 0 && other !== pid && isOurProcess(other)) {
        throw new Error(
          `another Whale operator is already running (pid ${other}, lock ${lockPath}). Two instances with the same keys race ` +
          `each other on the Hub. Stop it first (e.g. the live \`pnpm start\`) before starting or running the e2e.`,
        );
      }
      if (existsSync(lockPath)) unlinkSync(lockPath); // stale: take it over and retry once
    }
  }
  throw new Error(`could not acquire the instance lock at ${lockPath}`);
}
