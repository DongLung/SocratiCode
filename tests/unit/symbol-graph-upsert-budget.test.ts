// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QDRANT_MAX_REQUEST_BYTES, QDRANT_UPSERT_BUDGET_BYTES } from "../../src/constants.js";
import type { SymbolGraphFilePayload, SymbolNode } from "../../src/types.js";

// ── qdrant.js mock: capture every upsert body ───────────────────────────

interface CapturedUpsert {
  collName: string;
  points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }>;
}
const upserts: CapturedUpsert[] = [];

const mockUpsert = vi.fn(async (collName: string, body: CapturedUpsert["points"] extends never ? never : { points: CapturedUpsert["points"] }) => {
  upserts.push({ collName, points: body.points });
});

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({
    upsert: (collName: string, body: { points: CapturedUpsert["points"] }) => mockUpsert(collName, body),
    // ensureCollection() consults this; report the collection as already present
    // so the tests exercise the upsert path only.
    getCollections: async () => ({ collections: [{ name: "p_symgraph_file" }, { name: "p_symgraph_index" }] }),
    createCollection: async () => undefined,
  }),
  describeQdrantError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import {
  resetSymbolGraphCollectionCache,
  SymbolGraphPointTooLargeError,
  saveFilePayloads,
  saveNameShard,
} from "../../src/services/symbol-graph-store.js";

/** Build a payload whose serialized size is ~`targetBytes`. */
function payloadOfSize(file: string, targetBytes: number): SymbolGraphFilePayload {
  // One long symbol name is the cheapest way to control serialized size.
  const symbol: SymbolNode = {
    id: `${file}::big`,
    name: "x".repeat(Math.max(1, targetBytes)),
    kind: "function",
    file,
    language: "java",
    startLine: 1,
    endLine: 2,
  } as SymbolNode;
  return { file, language: "java", contentHash: "h", symbols: [symbol], outgoingCalls: [] };
}

/** Serialized size of one upsert body, the quantity Qdrant limits. */
function bodyBytes(u: CapturedUpsert): number {
  return Buffer.byteLength(JSON.stringify({ points: u.points }), "utf-8");
}

describe("symbol-graph-store: byte-aware upsert batching (#89)", () => {
  beforeEach(() => {
    upserts.length = 0;
    mockUpsert.mockClear();
    resetSymbolGraphCollectionCache();
  });

  it("keeps the historic 50-points-per-request batching for ordinary small files", async () => {
    // Regression guard: the byte budget must not change how normal repos batch.
    const payloads = Array.from({ length: 120 }, (_, i) => payloadOfSize(`src/f${i}.java`, 100));
    await saveFilePayloads("p", payloads);

    expect(upserts.map((u) => u.points.length)).toEqual([50, 50, 20]);
    expect(upserts.every((u) => bodyBytes(u) < QDRANT_UPSERT_BUDGET_BYTES)).toBe(true);
  });

  it("splits by BYTES when large files would otherwise exceed the request ceiling", async () => {
    // Six ~6 MB payloads: the old count-based batching put all six (~36 MB) in
    // one request, which is exactly the >32 MiB body Qdrant rejected with 400.
    const payloads = Array.from({ length: 6 }, (_, i) => payloadOfSize(`src/Big${i}.java`, 6_000_000));
    await saveFilePayloads("p", payloads);

    expect(upserts.length).toBeGreaterThan(1); // would have been exactly 1 before
    for (const u of upserts) {
      expect(bodyBytes(u)).toBeLessThanOrEqual(QDRANT_MAX_REQUEST_BYTES);
    }
    // Nothing is dropped: every file is still written exactly once.
    const written = upserts.flatMap((u) => u.points.map((p) => p.id));
    expect(new Set(written).size).toBe(6);
  });

  it("gives an oversized-but-writable point a request of its own", async () => {
    const payloads = [
      payloadOfSize("src/Small.java", 100),
      payloadOfSize("src/Huge.java", QDRANT_UPSERT_BUDGET_BYTES + 1_000_000),
      payloadOfSize("src/Small2.java", 100),
    ];
    await saveFilePayloads("p", payloads);

    const huge = upserts.find((u) => u.points.some((p) => JSON.stringify(p).length > QDRANT_UPSERT_BUDGET_BYTES));
    expect(huge).toBeDefined();
    expect(huge?.points).toHaveLength(1);
    for (const u of upserts) expect(bodyBytes(u)).toBeLessThanOrEqual(QDRANT_MAX_REQUEST_BYTES);
  });

  it("throws a named error instead of a bare 400 when one point cannot ever fit", async () => {
    const payloads = [payloadOfSize("src/Impossible.java", QDRANT_MAX_REQUEST_BYTES + 1024)];
    await expect(saveFilePayloads("p", payloads)).rejects.toThrow(SymbolGraphPointTooLargeError);
    await expect(saveFilePayloads("p", payloads)).rejects.toThrow(/src\/Impossible\.java/);
    await expect(saveFilePayloads("p", payloads)).rejects.toThrow(/max_request_size_mb/);
    // It must fail loudly rather than silently skipping the file.
    expect(upserts).toHaveLength(0);
  });

  it("names the offending shard when a name-index shard cannot fit", async () => {
    const nameToSymbols = {
      big: Array.from({ length: 1 }, () => ({
        file: "x".repeat(QDRANT_MAX_REQUEST_BYTES + 1024),
        id: "s",
      })),
    };
    await expect(saveNameShard("p", "b", nameToSymbols)).rejects.toThrow(SymbolGraphPointTooLargeError);
    await expect(saveNameShard("p", "b", nameToSymbols)).rejects.toThrow(/name index shard 'b'/);
    expect(upserts).toHaveLength(0);
  });

  it("writes an ordinary shard unchanged (single point, same payload shape)", async () => {
    await saveNameShard("p", "a", { alpha: [{ file: "src/A.java", id: "src/A.java::alpha" }] });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].points).toHaveLength(1);
    expect(upserts[0].points[0].payload).toEqual({
      kind: "name",
      shard: "a",
      nameToSymbols: { alpha: [{ file: "src/A.java", id: "src/A.java::alpha" }] },
    });
  });
});
