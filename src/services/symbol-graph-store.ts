// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Sharded Qdrant storage layer for the symbol-level call graph.
 *
 * Three collections per project (created lazily, idempotent):
 *   - `{projectId}_symgraph_meta`  → 1 point with `SymbolGraphMeta`
 *   - `{projectId}_symgraph_file`  → 1 point per source file (`SymbolGraphFilePayload`)
 *   - `{projectId}_symgraph_index` → sharded indices:
 *       • Name index — 27 shards keyed by first lowercased char of symbol name
 *       • Reverse-call file index — 256 shards keyed by first byte of SHA1(file)
 *
 * All points use the dummy-vector-`[0]` pattern (Qdrant requires a vector).
 */

import { createHash } from "node:crypto";
import {
  symgraphFileCollectionName,
  symgraphIndexCollectionName,
  symgraphMetaCollectionName,
} from "../config.js";
import {
  QDRANT_MAX_REQUEST_BYTES,
  QDRANT_UPSERT_BUDGET_BYTES,
  SYMBOL_REVERSE_SHARDS,
} from "../constants.js";
import type {
  SymbolGraphFilePayload,
  SymbolGraphMeta,
  SymbolRef,
} from "../types.js";
import { logger } from "./logger.js";
import { getClient } from "./qdrant.js";

// ── Shard key helpers ────────────────────────────────────────────────────

/** Map a symbol name to its name-index shard key (`a`–`z` or `_`). */
export function nameShardKey(name: string): string {
  if (!name) return "_";
  const c = name[0].toLowerCase();
  return c >= "a" && c <= "z" ? c : "_";
}

/** All 27 possible name-index shard keys (in stable order). */
export function allNameShardKeys(): string[] {
  const keys: string[] = ["_"];
  for (let i = 0; i < 26; i++) {
    keys.push(String.fromCharCode("a".charCodeAt(0) + i));
  }
  return keys;
}

/** Map a file path to its reverse-call shard bucket (0..SYMBOL_REVERSE_SHARDS-1). */
export function reverseShardKey(filePath: string): number {
  // SHA-256 used purely as a distribution function for sharding — not security-sensitive.
  const digest = createHash("sha256").update(filePath).digest();
  return digest[0] % SYMBOL_REVERSE_SHARDS;
}

/** Format a reverse-shard bucket as a 2-char zero-padded hex string. */
export function reverseShardHex(bucket: number): string {
  return bucket.toString(16).padStart(2, "0");
}

// ── Point IDs (UUID-formatted SHA-256 prefixes) ─────────────────────────

function uuidFromString(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function metaPointId(projectId: string): string {
  return uuidFromString(`${projectId}::meta`);
}
function filePointId(projectId: string, relativePath: string): string {
  return uuidFromString(`${projectId}::file::${relativePath}`);
}
function nameShardPointId(projectId: string, shardKey: string): string {
  return uuidFromString(`${projectId}::nameidx::${shardKey}`);
}
function revShardPointId(projectId: string, bucketHex: string): string {
  return uuidFromString(`${projectId}::revidx::${bucketHex}`);
}

// ── Upsert sizing ────────────────────────────────────────────────────────

/** A Qdrant point as this module writes them (dummy `[0]` vector throughout). */
interface SymgraphPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/**
 * A single point that cannot be written at all because it alone exceeds the
 * server's request ceiling. Thrown rather than skipped: dropping it would leave
 * the symbol graph silently missing a file's symbols, which is the failure mode
 * this whole area exists to avoid. The message names the offending item and the
 * knob that raises the ceiling.
 */
export class SymbolGraphPointTooLargeError extends Error {
  constructor(
    readonly what: string,
    readonly bytes: number,
    readonly limit: number = QDRANT_MAX_REQUEST_BYTES,
  ) {
    super(
      `${what} serializes to ${bytes} bytes, over Qdrant's ${limit}-byte request limit. ` +
        "Raise service.max_request_size_mb on the Qdrant server to accept it.",
    );
    this.name = "SymbolGraphPointTooLargeError";
  }
}

/** Serialized size of a point, matching what the client will send for it. */
function pointBytes(point: SymgraphPoint): number {
  return Buffer.byteLength(JSON.stringify(point), "utf-8");
}

/**
 * Guard a single-point upsert: a point over the hard ceiling can never be
 * written, so fail with a message naming it instead of letting Qdrant answer
 * with a bare "Bad Request" that says nothing about which shard was at fault.
 */
function assertPointFits(point: SymgraphPoint, what: string): void {
  const bytes = pointBytes(point);
  if (bytes > QDRANT_MAX_REQUEST_BYTES) {
    throw new SymbolGraphPointTooLargeError(what, bytes);
  }
}

/**
 * Upsert points in requests bounded by BOTH a point count and a byte budget.
 *
 * The count cap alone (what this module used to do) is the bug behind #89: a
 * fixed 50 points per request says nothing about how big those points are, and
 * large source files produce multi-MB payload points, so a handful of them in
 * one request pushes the body past Qdrant's 32 MiB ceiling and the whole batch
 * is rejected with HTTP 400. Packing by bytes keeps every request under the
 * ceiling regardless of how large individual files are; the count cap is kept
 * so ordinary repos still batch exactly as before.
 */
async function upsertWithinBudget(
  collName: string,
  points: SymgraphPoint[],
  describe: (index: number) => string,
): Promise<void> {
  const qdrant = getClient();
  let batch: SymgraphPoint[] = [];
  let batchBytes = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await qdrant.upsert(collName, { points: batch });
    batch = [];
    batchBytes = 0;
  };

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const bytes = pointBytes(point);
    if (bytes > QDRANT_MAX_REQUEST_BYTES) {
      // Deliberately abandon the queued batch rather than flushing it first.
      // This throw aborts persistSymbolGraph, so the run's metadata is never
      // written and the symbol graph stays unusable until a later build
      // rewrites every payload anyway. Flushing here would add points nothing
      // will read, to a collection already known to be incomplete.
      throw new SymbolGraphPointTooLargeError(describe(i), bytes);
    }
    // Start a new request when this point would push the body over budget, or
    // when the count cap is reached. A point larger than the budget but under
    // the ceiling ends up in a request of its own, which is what we want.
    if (batch.length > 0 && (batchBytes + bytes > QDRANT_UPSERT_BUDGET_BYTES || batch.length >= UPSERT_MAX_POINTS)) {
      await flush();
    }
    batch.push(point);
    batchBytes += bytes;
  }
  await flush();
}

/** Point-count cap per upsert. Unchanged from before the byte budget existed. */
const UPSERT_MAX_POINTS = 50;

// ── Collection lifecycle ─────────────────────────────────────────────────

const collectionsReady = new Set<string>();

/** Ensure a single collection exists (idempotent, cached after first success). */
async function ensureCollection(name: string): Promise<void> {
  if (collectionsReady.has(name)) return;
  const qdrant = getClient();
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === name);
  if (!exists) {
    await qdrant.createCollection(name, {
      vectors: { size: 1, distance: "Cosine" },
      on_disk_payload: true,
    });
    logger.info("Created symbol-graph collection", { name });
  }
  collectionsReady.add(name);
}

/** Reset readiness cache (testing only). */
export function resetSymbolGraphCollectionCache(): void {
  collectionsReady.clear();
}

/** Ensure all three symbol-graph collections exist for a project. */
export async function ensureSymbolGraphCollections(projectId: string): Promise<void> {
  await Promise.all([
    ensureCollection(symgraphMetaCollectionName(projectId)),
    ensureCollection(symgraphFileCollectionName(projectId)),
    ensureCollection(symgraphIndexCollectionName(projectId)),
  ]);
}

// ── Meta ─────────────────────────────────────────────────────────────────

export async function saveSymbolGraphMeta(
  projectId: string,
  meta: SymbolGraphMeta,
): Promise<void> {
  const collName = symgraphMetaCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  await qdrant.upsert(collName, {
    points: [{ id: metaPointId(projectId), vector: [0], payload: { meta } }],
  });
}

export async function loadSymbolGraphMeta(
  projectId: string,
): Promise<SymbolGraphMeta | null> {
  try {
    const collName = symgraphMetaCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const points = await qdrant.retrieve(collName, {
      ids: [metaPointId(projectId)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    const payload = points[0].payload;
    return (payload?.meta as SymbolGraphMeta) ?? null;
  } catch (err) {
    logger.warn("loadSymbolGraphMeta failed (returning null)", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Per-file payloads ────────────────────────────────────────────────────

export async function saveFilePayload(
  projectId: string,
  payload: SymbolGraphFilePayload,
): Promise<void> {
  const collName = symgraphFileCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  const point: SymgraphPoint = {
    id: filePointId(projectId, payload.file),
    vector: [0],
    payload: { filePayload: payload },
  };
  assertPointFits(point, `symbol payload for ${payload.file}`);
  await qdrant.upsert(collName, { points: [point] });
}

/**
 * Bulk upsert per-file payloads, in requests bounded by size as well as count.
 *
 * Point ids and payload shape are unchanged, so this writes exactly the same
 * data as before; only how it is split across HTTP requests differs.
 */
export async function saveFilePayloads(
  projectId: string,
  payloads: SymbolGraphFilePayload[],
): Promise<void> {
  if (payloads.length === 0) return;
  const collName = symgraphFileCollectionName(projectId);
  await ensureCollection(collName);
  const points: SymgraphPoint[] = payloads.map((p) => ({
    id: filePointId(projectId, p.file),
    vector: [0],
    payload: { filePayload: p },
  }));
  await upsertWithinBudget(collName, points, (i) => `symbol payload for ${payloads[i].file}`);
}

export async function loadFilePayload(
  projectId: string,
  relativePath: string,
): Promise<SymbolGraphFilePayload | null> {
  try {
    const collName = symgraphFileCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const points = await qdrant.retrieve(collName, {
      ids: [filePointId(projectId, relativePath)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    return (points[0].payload?.filePayload as SymbolGraphFilePayload) ?? null;
  } catch (err) {
    logger.warn("loadFilePayload failed (returning null)", {
      projectId,
      file: relativePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function deleteFilePayload(
  projectId: string,
  relativePath: string,
): Promise<void> {
  try {
    const collName = symgraphFileCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    await qdrant.delete(collName, {
      points: [filePointId(projectId, relativePath)],
    });
  } catch (err) {
    logger.warn("deleteFilePayload failed (ignored)", {
      projectId,
      file: relativePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Name index shards ────────────────────────────────────────────────────

export async function saveNameShard(
  projectId: string,
  shardKey: string,
  nameToSymbols: Record<string, SymbolRef[]>,
): Promise<void> {
  const collName = symgraphIndexCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  const point: SymgraphPoint = {
    id: nameShardPointId(projectId, shardKey),
    vector: [0],
    payload: { kind: "name", shard: shardKey, nameToSymbols },
  };
  // A name shard holds every symbol whose name starts with one character, so on
  // a large enough repo one shard can outgrow the request ceiling on its own.
  // Splitting it would change the on-disk layout; naming it in the error keeps
  // the failure honest and actionable without that.
  assertPointFits(point, `name index shard '${shardKey}'`);
  await qdrant.upsert(collName, { points: [point] });
}

export async function loadNameShard(
  projectId: string,
  shardKey: string,
): Promise<Record<string, SymbolRef[]> | null> {
  try {
    const collName = symgraphIndexCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const points = await qdrant.retrieve(collName, {
      ids: [nameShardPointId(projectId, shardKey)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    return (points[0].payload?.nameToSymbols as Record<string, SymbolRef[]>) ?? null;
  } catch (err) {
    logger.warn("loadNameShard failed (returning null)", {
      projectId,
      shardKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Reverse-call file index shards ───────────────────────────────────────

export async function saveReverseShard(
  projectId: string,
  bucket: number,
  reverseEdges: Record<string, string[]>,
): Promise<void> {
  const collName = symgraphIndexCollectionName(projectId);
  await ensureCollection(collName);
  const qdrant = getClient();
  const bucketHex = reverseShardHex(bucket);
  const point: SymgraphPoint = {
    id: revShardPointId(projectId, bucketHex),
    vector: [0],
    payload: { kind: "reverse", bucket, reverseEdges },
  };
  assertPointFits(point, `reverse-call index shard ${bucketHex}`);
  await qdrant.upsert(collName, { points: [point] });
}

export async function loadReverseShard(
  projectId: string,
  bucket: number,
): Promise<Record<string, string[]> | null> {
  try {
    const collName = symgraphIndexCollectionName(projectId);
    await ensureCollection(collName);
    const qdrant = getClient();
    const bucketHex = reverseShardHex(bucket);
    const points = await qdrant.retrieve(collName, {
      ids: [revShardPointId(projectId, bucketHex)],
      with_payload: true,
    });
    if (points.length === 0) return null;
    return (points[0].payload?.reverseEdges as Record<string, string[]>) ?? null;
  } catch (err) {
    logger.warn("loadReverseShard failed (returning null)", {
      projectId,
      bucket,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Bulk delete ──────────────────────────────────────────────────────────

/** Delete all symbol-graph data for a project (best-effort). */
export async function deleteSymbolGraphData(projectId: string): Promise<void> {
  const qdrant = getClient();
  const names = [
    symgraphMetaCollectionName(projectId),
    symgraphFileCollectionName(projectId),
    symgraphIndexCollectionName(projectId),
  ];
  const existing = await qdrant.getCollections();
  for (const name of names) {
    if (existing.collections.some((c) => c.name === name)) {
      try {
        await qdrant.deleteCollection(name);
        collectionsReady.delete(name);
      } catch (err) {
        logger.warn("deleteSymbolGraphData: deleteCollection failed (ignored)", {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** Compute SHA-256 of a string and return hex digest. Used for `contentHash`. */
export function contentHashOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// Helper exports for tests
export const _internal = {
  metaPointId,
  filePointId,
  nameShardPointId,
  revShardPointId,
};
