// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(), reclaim: vi.fn(), mode: "managed", host: "localhost", error: vi.fn(),
}));
vi.mock("../../src/constants.js", async (original) => ({
  ...await original<Record<string, unknown>>(), get QDRANT_MODE() { return mocks.mode; },
  get QDRANT_HOST() { return mocks.host; }, QDRANT_URL: undefined,
}));
vi.mock("../../src/services/qdrant.js", () => ({ getProjectReclamationInventory: mocks.inventory }));
vi.mock("../../src/tools/index-tools.js", () => ({ reclaimProjectIdentity: mocks.reclaim }));
vi.mock("../../src/services/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: mocks.error } }));

import { runAutomaticCleanup, startAutomaticCleanup, stopAutomaticCleanup } from "../../src/services/auto-cleanup.js";

const empty = { entries: [], unrecognisedMetadata: [], unattributedCollections: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inventory.mockReset().mockResolvedValue(empty);
  mocks.mode = "managed"; mocks.host = "localhost";
  vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", "local");
  vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
});
afterEach(async () => { await stopAutomaticCleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("automatic cleanup lifecycle and explicit local gate", () => {
  it("does not read inventory or start a timer by default", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", undefined);
    vi.useFakeTimers();
    startAutomaticCleanup();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(await runAutomaticCleanup()).toEqual([]);
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses external, remote and pinned configuration before reading any inventory", async () => {
    mocks.mode = "external";
    await expect(runAutomaticCleanup()).rejects.toThrow("shared/external");
    mocks.mode = "managed"; mocks.host = "remote.example.invalid";
    await expect(runAutomaticCleanup()).rejects.toThrow("loopback");
    mocks.host = "localhost"; vi.stubEnv("SOCRATICODE_PROJECT_ID", "shared");
    await expect(runAutomaticCleanup()).rejects.toThrow("pinned/shared");
    expect(mocks.inventory).not.toHaveBeenCalled();
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });

  it("runs immediately and periodically without overlapping; stopping drains pending work", async () => {
    vi.useFakeTimers();
    let complete!: (value: typeof empty) => void;
    mocks.inventory.mockReturnValueOnce(new Promise<typeof empty>((resolve) => { complete = resolve; }));
    startAutomaticCleanup();
    startAutomaticCleanup();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.inventory).toHaveBeenCalledTimes(1);
    let drained = false;
    const shutdown = stopAutomaticCleanup().then(() => { drained = true; });
    expect(drained).toBe(false);
    complete(empty);
    await shutdown;
    expect(drained).toBe(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.inventory).toHaveBeenCalledTimes(1);
    startAutomaticCleanup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.inventory).toHaveBeenCalledTimes(3);
  });

  it("reports backend failure as incomplete cleanup rather than a successful empty inventory", async () => {
    mocks.inventory.mockRejectedValue(new Error("synthetic Qdrant connection failure"));
    await expect(runAutomaticCleanup()).rejects.toThrow("connection failure");
    startAutomaticCleanup();
    await stopAutomaticCleanup();
    expect(mocks.error).toHaveBeenCalledWith("Automatic index cleanup failed; cleanup is not complete", { error: "synthetic Qdrant connection failure" });
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });
});
