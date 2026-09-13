// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * A pinned identity can be loaded through more than one checkout. Reclamation
 * deletes the identity's collections, so every cached graph that resolves to
 * that identity has to go — not only the one under the recorded path.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadGraphData = vi.fn(async (_collection: string) => ({ nodes: [], edges: [] }));

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/services/qdrant.js", () => ({
  loadGraphData: (...args: unknown[]) => mockLoadGraphData(...(args as [string])),
  getCollectionInfo: vi.fn(async () => null),
}));

import { projectIdFromPath } from "../../src/config.js";
import { getExistingGraph, invalidateGraphCache, invalidateGraphCacheForIdentity } from "../../src/services/code-graph.js";

const PINNED_ID = "pinned-shared-project";
let recordedCheckout: string;
let otherCheckout: string;
let unrelatedCheckout: string;

function checkoutPinnedTo(projectId: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-pinned-"));
  if (projectId) fs.writeFileSync(path.join(dir, ".socraticode.json"), JSON.stringify({ projectId }));
  return dir;
}

beforeEach(() => {
  mockLoadGraphData.mockClear();
  recordedCheckout = checkoutPinnedTo(PINNED_ID);
  otherCheckout = checkoutPinnedTo(PINNED_ID);
  unrelatedCheckout = checkoutPinnedTo(null);
});

afterEach(() => {
  for (const dir of [recordedCheckout, otherCheckout, unrelatedCheckout]) {
    invalidateGraphCache(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("invalidateGraphCacheForIdentity", () => {
  it("drops the graph cached through a checkout other than the recorded path", async () => {
    expect(projectIdFromPath(otherCheckout)).toBe(PINNED_ID);
    await getExistingGraph(recordedCheckout);
    await getExistingGraph(otherCheckout);
    await getExistingGraph(unrelatedCheckout);
    expect(mockLoadGraphData).toHaveBeenCalledTimes(3);

    // Path-keyed invalidation of the recorded path alone leaves the other checkout served from cache.
    invalidateGraphCache(recordedCheckout);
    await getExistingGraph(otherCheckout);
    expect(mockLoadGraphData).toHaveBeenCalledTimes(3);

    invalidateGraphCacheForIdentity(PINNED_ID);

    await getExistingGraph(otherCheckout);
    expect(mockLoadGraphData).toHaveBeenCalledTimes(4);
    await getExistingGraph(unrelatedCheckout);
    expect(mockLoadGraphData).toHaveBeenCalledTimes(4);
  });
});
