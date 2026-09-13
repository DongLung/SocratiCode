// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { acquireIdentityLock, holdsIdentityLock, isProjectIdentityLocked, releaseIdentityLock } from "./lock.js";
import { logger } from "./logger.js";

// Held from the final inventory validation through deletion, so no writer can start
// underneath a delete. Lock files are per host; another host sharing Qdrant is out of reach.

const BARRIER_OPERATION = "prune";
/** Locks a writer would take for the identity; held so none can start. */
export const WRITER_OPERATIONS = ["index", "watch", "graph", "context"] as const;
export type WriterOperation = (typeof WRITER_OPERATIONS)[number];

const heldBarriers = new Set<string>();

export class ReclamationBarrierError extends Error {
  constructor(
    readonly projectId: string,
    detail: string,
  ) {
    super(`Project ${projectId} is being reclaimed: ${detail}`);
    this.name = "ReclamationBarrierError";
  }
}

/** Whether this process is reclaiming the identity right now. */
export function isReclamationBarrierHeld(projectId: string): boolean {
  return heldBarriers.has(projectId);
}

/** Throws ReclamationBarrierError while the identity is being reclaimed here or on this host, and LockInspectionError when that cannot be told. */
export async function assertNoReclamationBarrier(projectId: string): Promise<void> {
  if (heldBarriers.has(projectId)) {
    throw new ReclamationBarrierError(projectId, "reclamation is in progress in this process");
  }
  if (await isProjectIdentityLocked(projectId, BARRIER_OPERATION)) {
    throw new ReclamationBarrierError(projectId, "another process holds its reclamation barrier");
  }
}

/** Hold a writer lock by identity for the duration of a write; false when another process holds it or it cannot be taken. */
export async function withWriterLock<T>(projectId: string, operation: WriterOperation, write: () => Promise<T>): Promise<T | null> {
  if (holdsIdentityLock(projectId, operation)) return null;
  if (!(await acquireIdentityLock(projectId, operation))) return null;
  try {
    return await write();
  } finally {
    await releaseIdentityLock(projectId, operation);
  }
}

export interface ReclamationBarrier {
  /** True once proper-lockfile reported any barrier lock lost; the delete must not proceed. */
  isCompromised(): boolean;
  release(): Promise<void>;
}

/** Take the barrier for an identity, or null when a writer holds any lock it needs; partial acquisition is undone. */
export async function acquireReclamationBarrier(projectId: string): Promise<ReclamationBarrier | null> {
  if (heldBarriers.has(projectId)) return null;

  const operations = [BARRIER_OPERATION, ...WRITER_OPERATIONS];
  // A lock this process already holds belongs to a live writer here; the barrier must not release it.
  if (operations.some((operation) => holdsIdentityLock(projectId, operation))) return null;

  let compromised = false;
  const acquired: string[] = [];
  const undo = async () => {
    for (const operation of [...acquired].reverse()) {
      await releaseIdentityLock(projectId, operation);
    }
  };

  for (const operation of operations) {
    let ok = false;
    try {
      ok = await acquireIdentityLock(projectId, operation, (err) => {
        compromised = true;
        logger.warn("Reclamation barrier lock compromised", { projectId, operation, error: err.message });
      });
    } catch (err) {
      logger.warn("Reclamation barrier lock acquisition threw", {
        projectId,
        operation,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!ok) {
      await undo();
      return null;
    }
    acquired.push(operation);
  }

  heldBarriers.add(projectId);
  return {
    isCompromised: () => compromised,
    release: async () => {
      heldBarriers.delete(projectId);
      await undo();
    },
  };
}

/** Test seam: forget every barrier this process holds without touching lock files. */
export function resetReclamationBarriers(): void {
  heldBarriers.clear();
}
