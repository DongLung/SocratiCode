// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockGetCollection = vi.fn();
const mockGetCollections = vi.fn();
const mockCreateCollection = vi.fn();
const mockCreatePayloadIndex = vi.fn();

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    getCollection = mockGetCollection;
    getCollections = mockGetCollections;
    createCollection = mockCreateCollection;
    createPayloadIndex = mockCreatePayloadIndex;
  },
}));

function qdrantError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done));
}

describe("ensureCollection concurrency", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCollection.mockReset();
    mockGetCollections.mockReset();
    mockCreateCollection.mockReset();
    mockCreatePayloadIndex.mockReset();
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreatePayloadIndex.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shares one initialization between concurrent callers", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    const first = ensureCollection("codebase_project");
    await entered.promise;
    const second = ensureCollection("codebase_project");
    gate.resolve();

    await Promise.all([first, second]);

    expect(mockGetCollections).toHaveBeenCalledTimes(1);
    expect(mockCreateCollection).toHaveBeenCalledTimes(1);
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("accepts an external collection-creation winner", async () => {
    mockCreateCollection.mockRejectedValue(qdrantError("Conflict", 409));

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("propagates a transient creation failure and retries later", async () => {
    mockCreateCollection
      .mockRejectedValueOnce(qdrantError("Service Unavailable", 503))
      .mockResolvedValueOnce(undefined);

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).rejects.toThrow("Service Unavailable");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreateCollection).toHaveBeenCalledTimes(2);
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(4);
  });

  it("ensures every payload index on an existing collection", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    await ensureCollection("codebase_project");

    expect(mockCreateCollection).not.toHaveBeenCalled();
    expect(mockCreatePayloadIndex.mock.calls).toEqual([
      ["codebase_project", { field_name: "filePath", field_schema: "keyword" }],
      ["codebase_project", { field_name: "relativePath", field_schema: "keyword" }],
      ["codebase_project", { field_name: "language", field_schema: "keyword" }],
      ["codebase_project", { field_name: "contentHash", field_schema: "keyword" }],
    ]);
  });

  it("accepts payload-index conflicts from another process", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });
    mockCreatePayloadIndex.mockRejectedValue(qdrantError("already exists", 409));

    const { ensureCollection } = await import("../../src/services/qdrant.js");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
  });

  it("propagates a payload-index failure and retries every index", async () => {
    mockGetCollections.mockResolvedValue({
      collections: [{ name: "codebase_project" }],
    });
    mockCreatePayloadIndex
      .mockRejectedValueOnce(qdrantError("Service Unavailable", 503))
      .mockResolvedValue(undefined);

    const { ensureCollection } = await import("../../src/services/qdrant.js");

    await expect(ensureCollection("codebase_project")).rejects.toThrow("Service Unavailable");
    await expect(ensureCollection("codebase_project")).resolves.toBeUndefined();
    expect(mockCreatePayloadIndex).toHaveBeenCalledTimes(8);
  });
});

describe("getCollectionInfo during this process's collection initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    mockGetCollection.mockReset();
    mockGetCollections.mockReset();
    mockCreateCollection.mockReset();
    mockCreatePayloadIndex.mockReset();
    mockGetCollections.mockResolvedValue({ collections: [] });
    mockCreateCollection.mockResolvedValue(undefined);
    mockCreatePayloadIndex.mockResolvedValue(undefined);
    mockGetCollection.mockResolvedValue({ status: "green", points_count: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("waits for a blocked create before reading, then reads the new collection", async () => {
    // Qdrant can answer a read made during the create with a 500.
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { ensureCollection, getCollectionInfo } = await import("../../src/services/qdrant.js");
    const creating = ensureCollection("codebase_project");
    await entered.promise;
    const reading = getCollectionInfo("codebase_project");
    await settle();

    expect(mockGetCollection).not.toHaveBeenCalled();

    gate.resolve();
    await creating;
    await expect(reading).resolves.toEqual({ pointsCount: 0, status: "green" });
    expect(mockGetCollection).toHaveBeenCalledTimes(1);
    // After the whole initialization, payload indexes included.
    const lastIndex = Math.max(...mockCreatePayloadIndex.mock.invocationCallOrder);
    expect(mockGetCollection.mock.invocationCallOrder[0]).toBeGreaterThan(lastIndex);
  });

  it("propagates a failed initialization to the reader instead of reading", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { ensureCollection, getCollectionInfo } = await import("../../src/services/qdrant.js");
    const creating = ensureCollection("codebase_project");
    await entered.promise;
    const reading = getCollectionInfo("codebase_project");
    await settle();

    gate.reject(qdrantError("Service Unavailable", 503));

    await expect(creating).rejects.toThrow("Service Unavailable");
    await expect(reading).rejects.toThrow("Service Unavailable");
    // Not turned into missing data: the collection was never read.
    expect(mockGetCollection).not.toHaveBeenCalled();
  });

  it("reads normally once a failed initialization has settled", async () => {
    mockCreateCollection.mockRejectedValueOnce(qdrantError("Service Unavailable", 503));

    const { ensureCollection, getCollectionInfo } = await import("../../src/services/qdrant.js");
    await expect(ensureCollection("codebase_project")).rejects.toThrow("Service Unavailable");

    await expect(getCollectionInfo("codebase_project")).resolves.toEqual({ pointsCount: 0, status: "green" });
  });

  it("does not wait on an initialization of a different collection", async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });

    const { ensureCollection, getCollectionInfo } = await import("../../src/services/qdrant.js");
    const creating = ensureCollection("codebase_other");
    await entered.promise;
    const reading = getCollectionInfo("codebase_project");
    await settle();

    // Read while the other collection's create is still blocked.
    expect(mockGetCollection).toHaveBeenCalledTimes(1);
    await expect(reading).resolves.toEqual({ pointsCount: 0, status: "green" });

    gate.resolve();
    await creating;
  });

  it("still propagates a 500 from the read made after a successful initialization", async () => {
    // Waiting must not hide a collection that is genuinely unhealthy.
    const gate = deferred<void>();
    const entered = deferred<void>();
    mockCreateCollection.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    mockGetCollection.mockRejectedValueOnce(qdrantError("Internal Server Error", 500));

    const { ensureCollection, getCollectionInfo } = await import("../../src/services/qdrant.js");
    const creating = ensureCollection("codebase_project");
    await entered.promise;
    const reading = getCollectionInfo("codebase_project");
    await settle();

    gate.resolve();
    await creating;
    await expect(reading).rejects.toThrow(
      "getCollectionInfo(collection=codebase_project) failed [status 500]: Internal Server Error",
    );
  });

  it("still propagates an unrelated 500 when no initialization is in flight", async () => {
    mockGetCollection.mockRejectedValue(qdrantError("Internal Server Error", 500));

    const { getCollectionInfo } = await import("../../src/services/qdrant.js");

    await expect(getCollectionInfo("codebase_project")).rejects.toThrow(
      "getCollectionInfo(collection=codebase_project) failed [status 500]: Internal Server Error",
    );
  });
});
