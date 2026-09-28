// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deletePoints } = vi.hoisted(() => ({ deletePoints: vi.fn() }));

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class { delete = deletePoints; },
}));
vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { deleteFileChunks } from "../../src/services/qdrant.js";

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
