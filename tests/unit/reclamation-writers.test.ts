// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Every writer asks the reclamation barrier before it starts, by the identity
 * its path resolves to, and stops when the barrier says no. The barrier itself
 * is exercised in reclamation-barrier.test.ts; here it is a switch, so what is
 * under test is only that each writer consults it and honours the answer,
 * including an answer of "unknown".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let barrierAnswer: Error | null = null;
const mockAssertNoReclamationBarrier = vi.fn(async (_projectId: string) => {
  if (barrierAnswer) throw barrierAnswer;
});

vi.mock("../../src/services/reclamation-barrier.js", () => ({
  assertNoReclamationBarrier: (...args: unknown[]) => mockAssertNoReclamationBarrier(...(args as [string])),
  withWriterLock: async (_id: string, _op: string, write: () => Promise<unknown>) => write(),
  WRITER_OPERATIONS: ["index", "watch", "graph", "context"],
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockAcquireProjectLock = vi.fn(async (..._args: unknown[]) => true);
const mockReleaseProjectLock = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../src/services/lock.js", () => ({
  acquireProjectLock: (...args: unknown[]) => mockAcquireProjectLock(...args),
  releaseProjectLock: (...args: unknown[]) => mockReleaseProjectLock(...args),
  holdsProjectLock: vi.fn(() => false),
  isProjectLocked: vi.fn(async () => false),
  isProjectIdentityLocked: vi.fn(async () => false),
  acquireIdentityLock: vi.fn(async () => true),
  releaseIdentityLock: vi.fn(async () => {}),
  holdsIdentityLock: vi.fn(() => false),
}));

const mockGetCollections = vi.fn(async () => ({ collections: [] as Array<{ name: string }> }));
vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({ getCollections: mockGetCollections }),
  getCollectionInfo: vi.fn(async () => null),
  getProjectMetadata: vi.fn(async () => null),
  loadProjectEffectiveProfile: vi.fn(async () => null),
  loadGraphData: vi.fn(async () => null),
  loadGraphInputs: vi.fn(async () => ({ status: "absent" })),
  loadContextIndexMetadata: vi.fn(async () => null),
}));

import { projectIdFromPath } from "../../src/config.js";
import { rebuildGraph } from "../../src/services/code-graph.js";
import { ensureArtifactsIndexed, indexAllArtifacts, isContextIndexingInProgress } from "../../src/services/context-artifacts.js";
import { indexProject, updateProjectIndex } from "../../src/services/indexer.js";
import { startWatching } from "../../src/services/watcher.js";

let project: string;
let identity: string;

beforeEach(() => {
  barrierAnswer = null;
  mockAssertNoReclamationBarrier.mockClear();
  mockAcquireProjectLock.mockClear();
  mockReleaseProjectLock.mockClear();
  project = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-writers-"));
  fs.writeFileSync(path.join(project, ".socraticode.json"), JSON.stringify({ projectId: "reclaimed-identity" }));
  identity = projectIdFromPath(project);
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

const refusals = [
  ["a barrier held in this process", () => Object.assign(new Error("Project reclaimed-identity is being reclaimed: reclamation is in progress in this process"), { name: "ReclamationBarrierError" })],
  ["a lock that cannot be inspected", () => Object.assign(new Error("Could not inspect the prune lock for reclaimed-identity: EACCES"), { name: "LockInspectionError" })],
] as const;

describe.each(refusals)("writers stop on %s", (_what, makeAnswer) => {
  beforeEach(() => {
    barrierAnswer = makeAnswer();
  });

  it("indexProject reports the refusal and takes no lock", async () => {
    const progress: string[] = [];
    const result = await indexProject(project, (message) => progress.push(message));

    expect(result).toEqual({ filesIndexed: 0, chunksCreated: 0, cancelled: false });
    expect(progress.join("\n")).toContain(barrierAnswer?.message);
    expect(mockAssertNoReclamationBarrier).toHaveBeenCalledWith(identity);
    expect(mockAcquireProjectLock).not.toHaveBeenCalled();
  });

  it("updateProjectIndex reports the refusal and takes no lock", async () => {
    const progress: string[] = [];
    const result = await updateProjectIndex(project, (message) => progress.push(message));

    expect(result).toEqual({ added: 0, updated: 0, removed: 0, chunksCreated: 0, cancelled: false });
    expect(progress.join("\n")).toContain(barrierAnswer?.message);
    expect(mockAssertNoReclamationBarrier).toHaveBeenCalledWith(identity);
    expect(mockAcquireProjectLock).not.toHaveBeenCalled();
  });

  it("startWatching answers false and takes no lock", async () => {
    const progress: string[] = [];
    expect(await startWatching(project, (message) => progress.push(message))).toBe(false);

    expect(progress.join("\n")).toContain(barrierAnswer?.message);
    expect(mockAssertNoReclamationBarrier).toHaveBeenCalledWith(identity);
    expect(mockAcquireProjectLock).not.toHaveBeenCalled();
  });

  it("rebuildGraph rejects before building", async () => {
    await expect(rebuildGraph(project)).rejects.toThrow(barrierAnswer?.message ?? "");
    expect(mockAssertNoReclamationBarrier).toHaveBeenCalledWith(identity);
  });

  it("context indexing rejects before reading the configuration, and records no activity", async () => {
    await expect(indexAllArtifacts(project)).rejects.toThrow(barrierAnswer?.message ?? "");
    await expect(ensureArtifactsIndexed(project)).rejects.toThrow(barrierAnswer?.message ?? "");
    expect(mockAssertNoReclamationBarrier).toHaveBeenCalledWith(identity);
    expect(isContextIndexingInProgress(project)).toBe(false);
  });
});
