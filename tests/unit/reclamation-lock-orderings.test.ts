// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * The race between a writer and reclamation is settled by the lock, not by
 * inference. Real lock files, real barrier; only the store and the file
 * watcher are stood in for. Two orders: reclamation holds the writer's lock
 * before the writer asks, and the writer holds it before reclamation asks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("proper-lockfile")>();
  return { default: { ...actual.default, lock: vi.fn(actual.default.lock) } };
});

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@parcel/watcher", () => ({
  default: { subscribe: vi.fn(async () => ({ unsubscribe: vi.fn(async () => {}) })) },
}));

/** Runs at each read of the store inside the writer's lock; an error aborts the writer, null lets it go on. */
let onStoreTouch: (() => Promise<Error | null>) | null = null;
const storeWrites = vi.fn();
async function touchStore(): Promise<null> {
  if (onStoreTouch) {
    const abort = await onStoreTouch();
    if (abort) {
      onStoreTouch = null;
      throw abort;
    }
  }
  return null;
}

/** The collection-state read, replaceable per test so an update can be told the store is empty. */
const collectionInfo = vi.fn(async (..._args: unknown[]): Promise<null> => touchStore());

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({ getCollections: async () => ({ collections: [] }) }),
  getCollectionInfo: (...args: unknown[]) => collectionInfo(...args),
  ensureCollection: (..._args: unknown[]) => touchStore(),
  loadProjectEffectiveProfile: (..._args: unknown[]) => touchStore(),
  getProjectMetadata: (..._args: unknown[]) => touchStore(),
  loadProjectHashes: (..._args: unknown[]) => touchStore(),
  loadGraphData: vi.fn(async () => null),
  loadGraphInputs: vi.fn(async () => ({ status: "absent" })),
  loadContextIndexMetadata: vi.fn(async () => null),
  upsertChunks: (...args: unknown[]) => storeWrites(...args),
  upsertPreEmbeddedChunks: (...args: unknown[]) => storeWrites(...args),
  deleteFileChunks: (...args: unknown[]) => storeWrites(...args),
  saveProjectMetadata: (...args: unknown[]) => storeWrites(...args),
  deleteCollection: (...args: unknown[]) => storeWrites(...args),
}));

import { projectIdFromPath } from "../../src/config.js";
import { indexProject, updateProjectIndex } from "../../src/services/indexer.js";
import { acquireIdentityLock, holdsIdentityLock, releaseAllLocks, releaseIdentityLock } from "../../src/services/lock.js";
import {
  acquireReclamationBarrier,
  isReclamationBarrierHeld,
  resetReclamationBarriers,
} from "../../src/services/reclamation-barrier.js";
import { startWatching, stopWatching } from "../../src/services/watcher.js";

const LOCK_DIR = path.join(os.tmpdir(), "socraticode-locks");
let project: string;
let identity: string;

function lockFilesHeld(): string[] {
  return ["prune", "index", "watch", "graph", "context"].filter((operation) => holdsIdentityLock(identity, operation));
}

beforeEach(() => {
  onStoreTouch = null;
  storeWrites.mockClear();
  collectionInfo.mockClear();
  vi.mocked(lockfile.lock).mockClear();
  resetReclamationBarriers();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-orderings-"));
  identity = `orderings-${path.basename(project).slice(-6)}`;
  fs.writeFileSync(path.join(project, ".socraticode.json"), JSON.stringify({ projectId: identity }));
  expect(projectIdFromPath(project)).toBe(identity);
});

afterEach(async () => {
  await stopWatching(project).catch(() => {});
  await releaseAllLocks();
  resetReclamationBarriers();
  fs.rmSync(project, { recursive: true, force: true });
  for (const operation of ["prune", "index", "watch", "graph", "context"]) {
    fs.rmSync(path.join(LOCK_DIR, `${identity}-${operation}`), { force: true });
  }
});

describe("reclamation holds the writer's lock before the writer asks", () => {
  it("indexProject is refused, writes nothing, and leaves the barrier's lock in place", async () => {
    const barrier = await acquireReclamationBarrier(identity);
    expect(barrier).not.toBeNull();
    const progress: string[] = [];

    const result = await indexProject(project, (message) => progress.push(message));

    expect(result).toEqual({ filesIndexed: 0, chunksCreated: 0, cancelled: false });
    expect(storeWrites).not.toHaveBeenCalled();
    expect(lockFilesHeld()).toEqual(["prune", "index", "watch", "graph", "context"]);
    await barrier?.release();
    expect(lockFilesHeld()).toEqual([]);
  });

  it("indexProject cannot adopt an index lock this process holds, even with no barrier flagged", async () => {
    // The lock alone, as reclamation holds it before its flag is visible to this check.
    expect(await acquireIdentityLock(identity, "index")).toBe(true);
    const progress: string[] = [];

    const result = await indexProject(project, (message) => progress.push(message));

    expect(result).toEqual({ filesIndexed: 0, chunksCreated: 0, cancelled: false });
    expect(progress.join("\n")).toContain("Another process is already indexing");
    expect(storeWrites).not.toHaveBeenCalled();
    expect(holdsIdentityLock(identity, "index")).toBe(true);
    await releaseIdentityLock(identity, "index");
  });

  it("updateProjectIndex cannot adopt an index lock this process holds", async () => {
    expect(await acquireIdentityLock(identity, "index")).toBe(true);

    const result = await updateProjectIndex(project);

    expect(result).toEqual({ added: 0, updated: 0, removed: 0, chunksCreated: 0, cancelled: false });
    expect(storeWrites).not.toHaveBeenCalled();
    expect(holdsIdentityLock(identity, "index")).toBe(true);
    await releaseIdentityLock(identity, "index");
  });

  it("startWatching cannot adopt a watch lock this process holds", async () => {
    expect(await acquireIdentityLock(identity, "watch")).toBe(true);

    expect(await startWatching(project)).toBe(false);

    expect(holdsIdentityLock(identity, "watch")).toBe(true);
    await releaseIdentityLock(identity, "watch");
  });
});

describe("the writer holds its lock before reclamation asks", () => {
  it("indexProject keeps and releases its own lock; the barrier stands down and clears its flag", async () => {
    let barrierAnswer: unknown = "not asked";
    onStoreTouch = async () => {
      expect(holdsIdentityLock(identity, "index")).toBe(true);
      barrierAnswer = await acquireReclamationBarrier(identity);
      expect(isReclamationBarrierHeld(identity)).toBe(false);
      // The barrier took nothing and released nothing: the writer's lock is still the writer's.
      expect(holdsIdentityLock(identity, "index")).toBe(true);
      return new Error("store aborted by the test");
    };

    await expect(indexProject(project)).rejects.toThrow("store aborted by the test");

    expect(barrierAnswer).toBeNull();
    expect(storeWrites).not.toHaveBeenCalled();
    expect(lockFilesHeld()).toEqual([]);
  });

  it("updateProjectIndex reaches the full-index fallback under its one lock, then releases it", async () => {
    // The update's collection-state read answers "empty", so it falls back to the full index.
    collectionInfo.mockImplementationOnce(async () => null);
    const progress: string[] = [];
    let inside: { locksTaken: number; held: boolean; barrier: unknown } | null = null;
    onStoreTouch = async () => {
      // The update's own reads pass; the first read of the fallback is where the question is asked.
      if (!progress.some((message) => message.includes("performing full index"))) return null;
      inside = {
        locksTaken: vi.mocked(lockfile.lock).mock.calls.length,
        held: holdsIdentityLock(identity, "index"),
        barrier: await acquireReclamationBarrier(identity),
      };
      return new Error("store aborted by the test");
    };

    await expect(updateProjectIndex(project, (message) => progress.push(message))).rejects.toThrow("store aborted by the test");

    expect(progress.join("\n")).toContain("performing full index");
    // One lock for the update and none for the fallback: the full index ran on the private locked path.
    expect(inside).toEqual({ locksTaken: 1, held: true, barrier: null });
    expect(storeWrites).not.toHaveBeenCalled();
    expect(lockFilesHeld()).toEqual([]);
  });

  it("startWatching keeps its lock while the barrier is refused, and releases it on stop", async () => {
    expect(await startWatching(project)).toBe(true);
    expect(holdsIdentityLock(identity, "watch")).toBe(true);

    expect(await acquireReclamationBarrier(identity)).toBeNull();
    expect(isReclamationBarrierHeld(identity)).toBe(false);
    expect(holdsIdentityLock(identity, "watch")).toBe(true);

    await stopWatching(project);
    expect(lockFilesHeld()).toEqual([]);
  });
});
