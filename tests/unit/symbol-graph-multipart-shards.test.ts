// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Issue #99: a name shard holds every symbol whose name starts with one
 * character and a reverse shard every caller list in its bucket, so both grow
 * with the whole repo. On a large enough codebase one bucket outgrew Qdrant's
 * request ceiling and the whole symbol-graph build aborted. Oversized shards
 * are now split across parts: part 0 stays on the shard's original id and
 * declares `parts: N`, continuation parts live at derived ids, and a shard
 * that fits stays a single point with no `parts` field — byte-identical to
 * what every existing graph contains.
 *
 * The mock below is a real in-memory point store (upsert/retrieve/delete), so
 * every test is a genuine write-then-read round trip, not an assertion on call
 * arguments alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QDRANT_UPSERT_BUDGET_BYTES } from "../../src/constants.js";
import type { SymbolRef } from "../../src/types.js";

interface StoredPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}
const store = new Map<string, Map<string, StoredPoint>>(); // collection -> id -> point
const requestBytes: number[] = []; // serialized size of every upsert request

vi.mock("../../src/services/qdrant.js", () => ({
  getClient: () => ({
    getCollections: async () => ({ collections: Array.from(store.keys()).map((name) => ({ name })) }),
    createCollection: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
    },
    upsert: async (name: string, body: { points: StoredPoint[] }) => {
      requestBytes.push(Buffer.byteLength(JSON.stringify(body), "utf-8"));
      const coll = store.get(name) ?? new Map<string, StoredPoint>();
      for (const p of body.points) coll.set(String(p.id), p);
      store.set(name, coll);
    },
    retrieve: async (name: string, opts: { ids: Array<string | number> }) => {
      const coll = store.get(name) ?? new Map<string, StoredPoint>();
      return opts.ids.map((id) => coll.get(String(id))).filter((p): p is StoredPoint => p !== undefined);
    },
    delete: async (name: string, opts: { points: Array<string | number> }) => {
      const coll = store.get(name);
      if (coll) for (const id of opts.points) coll.delete(String(id));
    },
  }),
  describeQdrantError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../../src/services/logger.js";
import {
  loadNameShard,
  loadReverseShard,
  resetSymbolGraphCollectionCache,
  SymbolGraphPointTooLargeError,
  saveNameShard,
  saveReverseShard,
} from "../../src/services/symbol-graph-store.js";

const PROJ = "multiparttest";
const INDEX_COLL = `${PROJ}_symgraph_index`;

function refsFor(name: string, count: number, pathLen = 60): SymbolRef[] {
  const refs: SymbolRef[] = [];
  for (let i = 0; i < count; i++) {
    const file = `src/${"x".repeat(pathLen)}/${name}${i}.java`;
    refs.push({ file, id: `${file}::${name}` });
  }
  return refs;
}

/** A record whose serialized size comfortably exceeds one part budget. */
function oversizedNameRecord(): Record<string, SymbolRef[]> {
  // ~180 bytes/ref -> ~1000 refs/name * 200 names ≈ 36 MB, > 24 MiB budget.
  const record: Record<string, SymbolRef[]> = {};
  for (let n = 0; n < 200; n++) record[`getValue${n}`] = refsFor(`getValue${n}`, 1000);
  return record;
}

function pointsInIndex(): StoredPoint[] {
  return Array.from(store.get(INDEX_COLL)?.values() ?? []);
}

describe("multi-part symbol shards (#99)", () => {
  beforeEach(() => {
    store.clear();
    requestBytes.length = 0;
    resetSymbolGraphCollectionCache();
    vi.mocked(logger.warn).mockClear();
  });

  it("keeps a small shard as ONE point with the exact legacy payload shape", async () => {
    const record = { alpha: refsFor("alpha", 2), beta: refsFor("beta", 1) };
    await saveNameShard(PROJ, "a", record);

    const points = pointsInIndex();
    expect(points).toHaveLength(1);
    // Byte-identical legacy shape: no part, no parts, same three fields.
    expect(Object.keys(points[0].payload).sort()).toEqual(["kind", "nameToSymbols", "shard"]);
    expect(points[0].payload).toEqual({ kind: "name", shard: "a", nameToSymbols: record });

    await expect(loadNameShard(PROJ, "a")).resolves.toEqual(record);
  });

  it("splits an oversized name shard and round-trips it exactly", async () => {
    const record = oversizedNameRecord();
    await saveNameShard(PROJ, "g", record);

    const points = pointsInIndex();
    expect(points.length).toBeGreaterThan(1);
    // Every part and every request stayed under the server's ceiling.
    for (const p of points) {
      expect(Buffer.byteLength(JSON.stringify(p), "utf-8")).toBeLessThanOrEqual(QDRANT_UPSERT_BUDGET_BYTES);
    }
    for (const b of requestBytes) expect(b).toBeLessThanOrEqual(QDRANT_UPSERT_BUDGET_BYTES * 1.05);

    // Part 0 sits on the shard's ORIGINAL id and declares the count.
    const primary = points.find((p) => (p.payload.part ?? 0) === 0 && p.payload.parts !== undefined);
    expect(primary).toBeDefined();
    expect(primary?.payload.parts).toBe(points.length);

    // The reader reassembles the exact record, no entry lost or duplicated.
    const loaded = await loadNameShard(PROJ, "g");
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded ?? {}).length).toBe(Object.keys(record).length);
    expect(loaded).toEqual(record);
  });

  it("reads a legacy single-point shard written before the split existed", async () => {
    // Simulate a pre-existing graph: a point with the old payload, planted
    // directly in the store rather than written through the new code.
    const record = { legacy: refsFor("legacy", 3) };
    store.set(INDEX_COLL, new Map());
    const { _internal } = await import("../../src/services/symbol-graph-store.js");
    const id = _internal.nameShardPointId(PROJ, "l");
    store.get(INDEX_COLL)?.set(id, { id, vector: [0], payload: { kind: "name", shard: "l", nameToSymbols: record } });

    await expect(loadNameShard(PROJ, "l")).resolves.toEqual(record);
  });

  it("deletes stale continuation parts when a shard shrinks back", async () => {
    await saveNameShard(PROJ, "s", oversizedNameRecord());
    const partsBefore = pointsInIndex().length;
    expect(partsBefore).toBeGreaterThan(1);

    const small = { solo: refsFor("solo", 1) };
    await saveNameShard(PROJ, "s", small);

    // Only the primary point remains; no orphaned parts accumulate.
    expect(pointsInIndex()).toHaveLength(1);
    await expect(loadNameShard(PROJ, "s")).resolves.toEqual(small);
  });

  it("splits and round-trips an oversized reverse shard the same way", async () => {
    // ~70 bytes/caller x 1200 callers x 450 callees ≈ 38 MB, over one budget.
    const record: Record<string, string[]> = {};
    for (let f = 0; f < 450; f++) {
      record[`src/${"y".repeat(60)}/Callee${f}.java`] = Array.from({ length: 1200 }, (_, i) => `src/${"z".repeat(60)}/Caller${i}.java`);
    }
    await saveReverseShard(PROJ, 7, record);
    expect(pointsInIndex().length).toBeGreaterThan(1);

    const loaded = await loadReverseShard(PROJ, 7);
    expect(loaded).toEqual(record);
  });

  it("returns null and warns when a declared continuation part is missing", async () => {
    await saveNameShard(PROJ, "m", oversizedNameRecord());
    // Corrupt the store: drop one continuation part (any non-primary point).
    const coll = store.get(INDEX_COLL);
    const continuation = pointsInIndex().find((p) => (p.payload.part as number) >= 1);
    expect(continuation).toBeDefined();
    coll?.delete(String(continuation?.id));

    await expect(loadNameShard(PROJ, "m")).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing continuation parts"),
      expect.objectContaining({ shardKey: "m" }),
    );
  });

  it("throws a named error when one ENTRY alone exceeds a part budget", async () => {
    // One symbol name with an absurd number of references — the only shape
    // entry-level splitting cannot place. Must fail loudly by name.
    const record = { megaSymbol: refsFor("megaSymbol", 160_000) };
    await expect(saveNameShard(PROJ, "z", record)).rejects.toThrow(SymbolGraphPointTooLargeError);
    await expect(saveNameShard(PROJ, "z", record)).rejects.toThrow(/megaSymbol/);
  });
});
