// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deletePoints, deleteCollection, getCollections } = vi.hoisted(() => ({ deletePoints: vi.fn(), deleteCollection: vi.fn(), getCollections: vi.fn() }));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class { delete = deletePoints; deleteCollection = deleteCollection; getCollections = getCollections; },
}));
vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { deleteFileChunks, type ProjectReclamationEntry, removeProjectReclamationEntry } from "../../src/services/qdrant.js";

describe("file deletion completion", () => {
  beforeEach(() => {
    deletePoints.mockReset().mockResolvedValue({ status: "completed" });
  });

  it("preserves the existing request when completion is not requested", async () => {
    await deleteFileChunks("codebase_fixture", "removed.ts");
    expect(deletePoints).toHaveBeenCalledWith("codebase_fixture", {
      filter: { must: [{ key: "relativePath", match: { value: "removed.ts" } }] },
    });
  });

  it("requires applied deletion when a Git refresh needs a synchronized result", async () => {
    await deleteFileChunks("codebase_fixture", "removed.ts", true);
    expect(deletePoints).toHaveBeenCalledWith("codebase_fixture", {
      filter: { must: [{ key: "relativePath", match: { value: "removed.ts" } }] },
      wait: true,
    });
  });

  it("propagates a failed completion request instead of reporting deletion success", async () => {
    deletePoints.mockRejectedValue(new Error("Qdrant deletion could not complete"));
    await expect(deleteFileChunks("codebase_fixture", "removed.ts", true)).rejects.toThrow("Qdrant deletion could not complete");
  });
});

describe("automatic cleanup keeps ownership until resource deletion is verified", () => {
  const entry: ProjectReclamationEntry = {
    identity: "fixture", projectPath: null, canonicalPath: null, pathState: "unknown/inaccessible",
    resourceCollections: ["codebase_fixture"], inProgress: false, possibleSuperseded: false,
    requiresManualInspection: false, manualInspectionReasons: [], confirmationToken: "synthetic",
    metadataRecords: [{ pointId: 1, collectionName: "codebase_fixture", projectPath: null, indexingStatus: "completed", lastIndexedAt: null, lastBuiltAt: null, builtByVersion: null }],
  };
  beforeEach(() => {
    deletePoints.mockReset().mockResolvedValue({ status: "completed" });
    deleteCollection.mockReset().mockResolvedValue(true);
    getCollections.mockReset().mockResolvedValue({ collections: [] });
  });
  it("retains metadata after a real deletion error or a success response with a leftover collection", async () => {
    deleteCollection.mockRejectedValueOnce(new Error("synthetic delete failure"));
    expect((await removeProjectReclamationEntry(entry, () => true, true)).map((result) => result.outcome)).toEqual(["failed", "skipped"]);
    expect(deletePoints).not.toHaveBeenCalled();
    getCollections.mockResolvedValue({ collections: [{ name: "codebase_fixture" }] });
    const result = await removeProjectReclamationEntry(entry, () => true, true);
    expect(result[0]).toMatchObject({ outcome: "failed", error: "the collection is still stored after deletion" });
    expect(deletePoints).not.toHaveBeenCalled();
  });
  it("deletes metadata only after collections are verified absent, and refuses withdrawn authorization", async () => {
    expect((await removeProjectReclamationEntry(entry, () => true, true)).map((result) => result.outcome)).toEqual(["deleted", "deleted"]);
    deleteCollection.mockClear(); deletePoints.mockClear();
    expect((await removeProjectReclamationEntry(entry, async () => false, true)).map((result) => result.outcome)).toEqual(["skipped", "skipped"]);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(deletePoints).not.toHaveBeenCalled();
  });
  it("reports the verification failure for each resource and retains ownership metadata", async () => {
    getCollections.mockRejectedValueOnce(new Error("synthetic verification connection failure"));
    const result = await removeProjectReclamationEntry(entry, () => true, true);
    expect(result.map((outcome) => outcome.outcome)).toEqual(["failed", "skipped"]);
    expect(result.every((outcome) => outcome.error?.includes("synthetic verification connection failure"))).toBe(true);
    expect(deletePoints).not.toHaveBeenCalled();
  });
});
