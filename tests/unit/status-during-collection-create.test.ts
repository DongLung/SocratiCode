// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * codebase_status polled while a first index is still inside createCollection
 * (#176).
 *
 * A GET /collections/{name} sent while the PUT creating that collection is
 * still in flight is answered by Qdrant (observed on 1.17.0 and 1.19.1) with
 *
 *   500 "Service internal error: 0 of 0 read operations failed"
 *
 * The stubbed client below answers every read made during the create that way,
 * so a status poll only succeeds by not reading until the create is done.
 * `indexProject`, `ensureCollection`, `getCollectionInfo` and `handleQueryTool`
 * all run as shipped; only the Qdrant client, metadata I/O and infrastructure
 * are stubbed.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CollectionState = "absent" | "creating" | "ready";
let state: CollectionState = "absent";
let tempRoot = "";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let createEntered = deferred();
let createGate = deferred();
/** Holds the index's first upsert, so it is still running when status reads it. */
let upsertGate = deferred();

/** The shape @qdrant/js-client-rest throws: message is the HTTP status text, the reason is in data. */
function apiError(status: number, statusText: string, reason: string): Error & { status: number } {
  const err = new Error(statusText) as Error & { status: number; data: unknown };
  err.status = status;
  err.data = { status: { error: reason } };
  return err;
}

const getCollectionCalls: CollectionState[] = [];

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    async getCollections() {
      return { collections: state === "absent" ? [] : [{ name: "test-collection" }] };
    }
    async createCollection() {
      state = "creating";
      createEntered.resolve();
      await createGate.promise;
      state = "ready";
      return true;
    }
    async createPayloadIndex() {
      return {};
    }
    async getCollection() {
      getCollectionCalls.push(state);
      if (state === "absent") throw apiError(404, "Not Found", "Collection `test-collection` doesn't exist!");
      if (state === "creating") {
        throw apiError(500, "Internal Server Error", "Service internal error: 0 of 0 read operations failed");
      }
      return {
        status: "green",
        points_count: 0,
        config: { params: { vectors: { dense: { size: 3, distance: "Cosine" } } } },
      };
    }
    async upsert() {
      await upsertGate.promise;
      return {};
    }
  },
}));

vi.mock("../../src/services/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/services/qdrant-client-compat.js", () => ({
  ensureQdrantClientCompatibility: vi.fn(),
}));

vi.mock("../../src/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config.js")>();
  return { ...actual, collectionName: vi.fn(() => "test-collection") };
});

vi.mock("../../src/services/docker.js", () => ({
  ensureQdrantReady: vi.fn(async () => ({ pulled: false, started: false })),
}));

vi.mock("../../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: vi.fn(async () => ({
    ensureReady: vi.fn(async () => ({ modelPulled: false, containerStarted: false, imagePulled: false })),
  })),
}));

vi.mock("../../src/services/embeddings.js", () => ({
  prepareDocumentText: vi.fn((content: string) => content),
  generateEmbeddings: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.1, 0.1])),
}));

// Real getCollectionInfo and ensureCollection; metadata I/O stubbed.
vi.mock("../../src/services/qdrant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/qdrant.js")>();
  return {
    ...actual,
    deleteFileChunks: vi.fn(async () => undefined),
    getProjectMetadata: vi.fn(async () => null),
    loadIndexingStatus: vi.fn(async () => null),
    loadProjectEffectiveProfile: vi.fn(async () => null),
    loadProjectHashes: vi.fn(async () => null),
    saveProjectMetadata: vi.fn(async () => undefined),
  };
});

vi.mock("../../src/services/code-graph.js", () => ({
  ensureDynamicLanguages: vi.fn(),
  gdscriptParserAvailable: vi.fn(() => false),
  getAstGrepLang: vi.fn(() => null),
  getGraphStatus: vi.fn(async () => null),
  isGraphBuilderStale: vi.fn(() => false),
  rebuildGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
  removeGraph: vi.fn(async () => undefined),
  shouldRebuildGraph: vi.fn(() => false),
}));

vi.mock("../../src/services/context-artifacts.js", () => ({
  ensureArtifactsIndexed: vi.fn(async () => undefined),
  getArtifactStatusSummary: vi.fn(async () => null),
  loadConfig: vi.fn(async () => null),
  removeAllArtifacts: vi.fn(async () => undefined),
}));

vi.mock("../../src/services/elixir-templates.js", () => ({
  analyzeElixirTemplate: vi.fn(() => null),
  ensureElixirTemplateParsers: vi.fn(async () => undefined),
  isElixirTemplateExtension: vi.fn(() => false),
}));

vi.mock("../../src/services/watcher.js", () => ({
  ensureWatcherStarted: vi.fn(),
  isWatchedByAnyProcess: vi.fn(async () => false),
  isWatching: vi.fn(() => false),
}));

vi.mock("../../src/services/lock.js", () => ({
  acquireIdentityLock: vi.fn(async () => true),
  acquireProjectLock: vi.fn(async () => true),
  getLockHolderPid: vi.fn(async () => null),
  holdsIdentityLock: vi.fn(() => false),
  holdsProjectLock: vi.fn(() => false),
  isProjectIdentityLocked: vi.fn(async () => false),
  releaseIdentityLock: vi.fn(async () => {}),
  releaseProjectLock: vi.fn(async () => undefined),
}));

const originalEnv = { ...process.env };

beforeEach(async () => {
  vi.resetModules();
  state = "absent";
  getCollectionCalls.length = 0;
  createEntered = deferred();
  createGate = deferred();
  upsertGate = deferred();
  process.env = {
    ...originalEnv,
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test-model",
    EMBEDDING_DIMENSIONS: "3",
    EMBEDDING_CONTEXT_LENGTH: "512",
    EMBEDDING_DOCUMENT_INCLUDE_PATH: "false",
    SOCRATICODE_WATCHER: "off",
  };
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "socraticode-status-create-"));
});

afterEach(async () => {
  createGate.resolve();
  upsertGate.resolve();
  process.env = { ...originalEnv };
  await fsp.rm(tempRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("codebase_status during a first index's createCollection", () => {
  it("waits for the create and then reports the active index", async () => {
    const indexer = await import("../../src/services/indexer.js");
    const { handleQueryTool } = await import("../../src/tools/query-tools.js");
    const project = await fsp.mkdtemp(path.join(tempRoot, "project-"));
    await fsp.writeFile(path.join(project, "a.ts"), "export const a = 1;\n");

    // What codebase_index does: start the full index and do not await it.
    const run = indexer.indexProject(project);
    await createEntered.promise;
    expect(indexer.isIndexingInProgress(project)).toBe(true);

    // A poll lands while the collection is being created.
    let settled = false;
    const status = handleQueryTool("codebase_status", { projectPath: project }).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));

    // It has not read the collection mid-create, which Qdrant would answer with a 500.
    expect(getCollectionCalls).not.toContain("creating");
    expect(settled).toBe(false);

    createGate.resolve();
    const text = await status;

    expect(text).toContain("Collection: test-collection");
    expect(text).toContain("Indexed chunks: 0");
    expect(text).toContain("Full index in progress");

    upsertGate.resolve();
    await expect(run).resolves.toMatchObject({ cancelled: false });
  });
});
