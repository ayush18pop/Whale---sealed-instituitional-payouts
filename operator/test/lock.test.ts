import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { acquireInstanceLock } from "../src/lock.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "whale-lock-")), "operator.lock");

describe("single-instance lock", () => {
  it("acquires, records the pid, and releases", () => {
    const p = tmp();
    const release = acquireInstanceLock(p, 4242);
    expect(readFileSync(p, "utf8")).toBe("4242");
    release();
    expect(existsSync(p)).toBe(false);
  });

  it("takes over a stale lock whose pid is dead", () => {
    const p = tmp();
    writeFileSync(p, "2147483646"); // no such process
    const release = acquireInstanceLock(p, 4242);
    expect(readFileSync(p, "utf8")).toBe("4242");
    release();
  });

  it("takes over a lock whose pid is alive but is not an operator (pid reuse)", () => {
    const p = tmp();
    writeFileSync(p, String(process.pid)); // this test runner is alive, but not running index.ts
    const release = acquireInstanceLock(p, 4242);
    expect(readFileSync(p, "utf8")).toBe("4242");
    release();
  });

  it("refuses to start while a live operator process holds the lock", async () => {
    // a throwaway process whose command line contains index.ts stands in for a running operator
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)", "index.ts"], { stdio: "ignore" });
    try {
      const p = tmp();
      writeFileSync(p, String(child.pid));
      expect(() => acquireInstanceLock(p, 4242)).toThrow(/another Whale operator is already running/);
      expect(readFileSync(p, "utf8")).toBe(String(child.pid)); // the lock was not stolen
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("release does not delete a lock that another instance has since taken", () => {
    const p = tmp();
    const release = acquireInstanceLock(p, 4242);
    writeFileSync(p, "9999");
    release();
    expect(readFileSync(p, "utf8")).toBe("9999");
  });
});
