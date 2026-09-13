// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * The reclamation barrier is what stands between a prune and every writer.
 * It must exclude across processes through the same lock files an indexer or
 * watcher would take, refuse to stand on a lock this process already holds,
 * and fail closed when a lock cannot be read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const locks = new Map<string, boolean>();
let checkFailure: Error | null = null;

vi.mock("proper-lockfile", () => ({
  default: {
    lock: vi.fn(async (filePath: string) => {
      if (locks.get(filePath)) {
        const err = new Error("Lock file is already being held") as NodeJS.ErrnoException;
        err.code = "ELOCKED";
        throw err;
      }
      locks.set(filePath, true);
      return async () => {
        locks.delete(filePath);
      };
    }),
    check: vi.fn(async (filePath: string) => {
      if (checkFailure) throw checkFailure;
      return locks.get(filePath) ?? false;
    }),
  },
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { acquireIdentityLock, LockInspectionError, releaseAllLocks } from "../../src/services/lock.js";
import {
  acquireReclamationBarrier,
  assertNoReclamationBarrier,
  isReclamationBarrierHeld,
  ReclamationBarrierError,
  resetReclamationBarriers,
  withWriterLock,
} from "../../src/services/reclamation-barrier.js";

const ALL_OPERATIONS = ["prune", "index", "watch", "graph", "context"] as const;

const IDENTITY = "pinned-project";

function heldKeys(): string[] {
  return Array.from(locks.keys())
    .map((filePath) => filePath.split(/[\\/]/).pop() ?? filePath)
    .sort();
}

/** Mirrors LOCK_DIR in lock.ts: the file another process would have locked. */
const LOCK_DIR = path.join(os.tmpdir(), "socraticode-locks");

/** What another process holding a lock looks like from here: the file exists and is locked, nothing in heldLocks. */
function lockHeldElsewhere(operation: string): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const filePath = path.join(LOCK_DIR, `${IDENTITY}-${operation}`);
  fs.writeFileSync(filePath, "999999\n", "utf-8");
  locks.set(filePath, true);
}

beforeEach(() => {
  locks.clear();
  checkFailure = null;
  resetReclamationBarriers();
});

afterEach(async () => {
  await releaseAllLocks();
  vi.restoreAllMocks();
  for (const operation of ALL_OPERATIONS) {
    fs.rmSync(path.join(LOCK_DIR, `${IDENTITY}-${operation}`), { force: true });
  }
});

describe("acquireReclamationBarrier", () => {
  it("holds the prune lock and every writer lock of the identity until released", async () => {
    const barrier = await acquireReclamationBarrier(IDENTITY);
    expect(barrier).not.toBeNull();
    expect(isReclamationBarrierHeld(IDENTITY)).toBe(true);
    expect(barrier?.isCompromised()).toBe(false);
    expect(heldKeys()).toEqual([...ALL_OPERATIONS].map((operation) => `${IDENTITY}-${operation}`).sort());

    await barrier?.release();
    expect(isReclamationBarrierHeld(IDENTITY)).toBe(false);
    expect(heldKeys()).toEqual([]);
  });

  it("refuses while another process holds a writer lock, and leaves nothing behind", async () => {
    lockHeldElsewhere("watch");

    expect(await acquireReclamationBarrier(IDENTITY)).toBeNull();
    expect(isReclamationBarrierHeld(IDENTITY)).toBe(false);
    expect(heldKeys()).toEqual([`${IDENTITY}-watch`]);
  });

  it("refuses to stand on a writer lock this process holds", async () => {
    expect(await acquireIdentityLock(IDENTITY, "index")).toBe(true);

    expect(await acquireReclamationBarrier(IDENTITY)).toBeNull();
    // The writer's lock is untouched: the barrier never took it, so it never released it.
    expect(heldKeys()).toEqual([`${IDENTITY}-index`]);
  });

  it("is exclusive with itself", async () => {
    const first = await acquireReclamationBarrier(IDENTITY);
    expect(first).not.toBeNull();
    expect(await acquireReclamationBarrier(IDENTITY)).toBeNull();
    await first?.release();
  });
});

describe("assertNoReclamationBarrier", () => {
  it("lets a writer start when nothing is being reclaimed", async () => {
    await expect(assertNoReclamationBarrier(IDENTITY)).resolves.toBeUndefined();
  });

  it("stops a writer in this process while the barrier is held", async () => {
    const barrier = await acquireReclamationBarrier(IDENTITY);
    await expect(assertNoReclamationBarrier(IDENTITY)).rejects.toBeInstanceOf(ReclamationBarrierError);
    await barrier?.release();
    await expect(assertNoReclamationBarrier(IDENTITY)).resolves.toBeUndefined();
  });

  it("stops a writer in another process through the prune lock file", async () => {
    lockHeldElsewhere("prune");
    await expect(assertNoReclamationBarrier(IDENTITY)).rejects.toThrow(/another process holds its reclamation barrier/);
  });

  it("fails closed when the lock cannot be inspected", async () => {
    checkFailure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    lockHeldElsewhere("prune");
    await expect(assertNoReclamationBarrier(IDENTITY)).rejects.toBeInstanceOf(LockInspectionError);
  });

  it("fails closed when the lock file itself cannot be read", async () => {
    const statSync = fs.statSync;
    vi.spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).endsWith(`${IDENTITY}-prune`)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return (statSync as (...args: unknown[]) => fs.Stats)(target, ...rest);
    }) as typeof fs.statSync);
    await expect(assertNoReclamationBarrier(IDENTITY)).rejects.toBeInstanceOf(LockInspectionError);
  });
});

describe("withWriterLock", () => {
  it("holds the writer lock for the duration of the write and releases it", async () => {
    let heldDuringWrite: string[] = [];
    const result = await withWriterLock(IDENTITY, "graph", async () => {
      heldDuringWrite = heldKeys();
      return "built";
    });
    expect(result).toBe("built");
    expect(heldDuringWrite).toEqual([`${IDENTITY}-graph`]);
    expect(heldKeys()).toEqual([]);
  });

  it("answers null while another process holds the lock", async () => {
    lockHeldElsewhere("context");
    expect(await withWriterLock(IDENTITY, "context", async () => "written")).toBeNull();
  });

  it("answers null while the barrier holds the lock in this process", async () => {
    const barrier = await acquireReclamationBarrier(IDENTITY);
    expect(await withWriterLock(IDENTITY, "graph", async () => "written")).toBeNull();
    await barrier?.release();
  });

  it("does not stop a writer of a different identity", async () => {
    const barrier = await acquireReclamationBarrier(IDENTITY);
    await expect(assertNoReclamationBarrier("another-project")).resolves.toBeUndefined();
    await barrier?.release();
  });
});
