// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Issue #94: cross-project ranking needs a cosine per hit, so the dense vector
 * has to be read back for the shapes the client actually returns, and no cosine
 * produced whenever one is not defined. That second half matters more than it
 * looks: it is what makes the merge fall back to rank fusion, and a wrong number
 * would mis-rank silently instead.
 *
 * Driven through `searchMultipleCollections` — the entry point production uses —
 * against a mocked Qdrant, so what is asserted is the visible outcome (which
 * score scale the results come back on) rather than an internal field.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    query = (...args: unknown[]) => mockQuery(...args);
  },
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const QUERY_VECTOR = [1, 0, 0];
vi.mock("../../src/services/embeddings.js", () => ({
  generateQueryEmbedding: vi.fn(async () => [1, 0, 0]),
  generateEmbeddings: vi.fn(async () => []),
  prepareDocumentText: vi.fn((s: string) => s),
}));

import { logger } from "../../src/services/logger.js";
import { searchMultipleCollections } from "../../src/services/qdrant.js";

/** One Qdrant point carrying whatever vector shape the case is about. */
function point(relativePath: string, vector: unknown, score = 0.5) {
  return {
    id: relativePath,
    score,
    vector,
    payload: {
      filePath: `/p/${relativePath}`,
      relativePath,
      content: "x",
      startLine: 1,
      endLine: 2,
      language: "typescript",
    },
  };
}

const COLLECTIONS = [
  { name: "coll-a", label: "project-a" },
  { name: "coll-b", label: "project-b" },
];

/** Rank-0 fusion score — what results fall back to when cosine is unavailable. */
const RRF_RANK0 = 1 / 61;

describe("dense-vector handling for cross-project ranking (#94)", () => {
  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(logger.warn).mockClear();
  });

  it("ranks on cosine when vectors come back as bare arrays", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] }) // identical → 1
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 1, 0])] }); // 45° → 1/√2

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.map((r) => r.relativePath)).toEqual(["a.ts", "b.ts"]);
    expect(results[0].score).toBeCloseTo(1, 10);
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("reads a named `dense` vector, ignoring the sparse one beside it", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", { dense: [1, 0, 0], bm25: { indices: [1], values: [2] } })] })
      .mockResolvedValueOnce({ points: [point("b.ts", { dense: [1, 1, 0] })] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results[0].score).toBeCloseTo(1, 10);
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("falls back to rank fusion when a vector's dimensionality differs", async () => {
    // Scoring a prefix would return a plausible number computed across two
    // embedding spaces, so the whole query drops to fusion instead.
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 0, 0, 0, 0])] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results).toHaveLength(2);
    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to rank fusion"),
      expect.objectContaining({ pointDim: 5, queryDim: QUERY_VECTOR.length }),
    );
  });

  it("falls back to rank fusion for a zero-magnitude vector", async () => {
    // Cosine is undefined against a zero vector; scoring it 0 would be an
    // invention that buries an otherwise good hit.
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [0, 0, 0])] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("falls back to rank fusion when a point carries no usable vector", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", { bm25: { indices: [1], values: [2] } })] });

    const results = await searchMultipleCollections(COLLECTIONS, "q", 10);

    expect(results.every((r) => Math.abs(r.score - RRF_RANK0) < 1e-9)).toBe(true);
  });

  it("asks for the dense vector by name, so the sparse vector stays behind", async () => {
    mockQuery
      .mockResolvedValueOnce({ points: [point("a.ts", [1, 0, 0])] })
      .mockResolvedValueOnce({ points: [point("b.ts", [1, 0, 0])] });

    await searchMultipleCollections(COLLECTIONS, "q", 10);

    // Every collection, not just the first: one omitting it would leave its hits
    // without a cosine, which silently drops the whole query to rank fusion.
    expect(mockQuery.mock.calls).toHaveLength(COLLECTIONS.length);
    for (const [, payload] of mockQuery.mock.calls) {
      expect(payload).toMatchObject({ with_vector: ["dense"] });
    }
  });

  it("does not request vectors for a single-collection search", async () => {
    // One linked project short-circuits to the ordinary path, which must stay
    // byte-for-byte what it was: no vector on the wire, RRF score untouched.
    mockQuery.mockResolvedValueOnce({ points: [point("a.ts", undefined, 0.42)] });

    const results = await searchMultipleCollections([COLLECTIONS[0]], "q", 10);

    expect(results[0].score).toBeCloseTo(0.42, 10);
    expect(mockQuery.mock.calls[0][1]).not.toHaveProperty("with_vector");
  });
});
