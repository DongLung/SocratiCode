// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionName } from "../../src/config.js";
import { checkGitRefresh, finishGitIndex, gitRefreshStatus, prepareGitIndex, resumeGitRefresh, stopAllGitRefreshes, stopGitRefresh, withGitRefreshNotice } from "../../src/services/git-refresh.js";
import { type GitRefreshTarget, gitProjectId, readGitState } from "../../src/services/git-state.js";
import { createGitFixture, git } from "../helpers/git.js";

const mocks = vi.hoisted(() => ({ info: vi.fn(), update: vi.fn(), busy: vi.fn(), invalidate: vi.fn() }));
vi.mock("../../src/services/qdrant.js", () => ({ getCollectionInfo: mocks.info }));
vi.mock("../../src/services/indexer.js", () => ({ updateProjectIndex: mocks.update, isIndexingInProgress: mocks.busy }));
vi.mock("../../src/services/code-graph.js", () => ({ invalidateGraphCache: mocks.invalidate }));

const success = { added: 0, updated: 0, removed: 0, chunksCreated: 0, cancelled: false };

describe("Git refresh lifecycle with real checkout transitions", () => {
  let fixture: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    fixture = createGitFixture();
    vi.stubEnv("SOCRATICODE_WATCHER", "git");
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
    mocks.info.mockReset().mockResolvedValue({ pointsCount: 1 });
    mocks.update.mockReset().mockResolvedValue(success);
    mocks.busy.mockReset().mockReturnValue(false);
    mocks.invalidate.mockClear();
  });
  afterEach(async () => {
    stopAllGitRefreshes();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fixture.cleanup();
  });

  async function synchronize() {
    await resumeGitRefresh(fixture.root);
    expect(gitRefreshStatus(fixture.root)).toContain("synchronized");
  }

  it.each(["auto", "manual", "off"])("leaves %s mode untouched", async (mode) => {
    vi.stubEnv("SOCRATICODE_WATCHER", mode);
    await checkGitRefresh(fixture.root);
    expect(await withGitRefreshNotice(fixture.root, async () => "original response")).toBe("original response");
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not create an initial index, including on a later branch switch", async () => {
    mocks.info.mockResolvedValue(null);
    await checkGitRefresh(fixture.root);
    git(fixture.root, "checkout", "-b", "other");
    await checkGitRefresh(fixture.root);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(gitRefreshStatus(fixture.root)).toContain("no existing index");
  });

  it("AUTO_RESUME=off leaves startup freshness unverified and starts work only on a Git transition", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "off");
    await checkGitRefresh(fixture.root);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(gitRefreshStatus(fixture.root)).toContain("unverified");
    git(fixture.root, "commit", "--allow-empty", "-m", "New fixture state");
    await checkGitRefresh(fixture.root);
    await vi.waitFor(() => expect(gitRefreshStatus(fixture.root)).toContain("synchronized"));
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it("preserves a transition to an existing index when initial registration found no collection", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "off");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    mocks.info.mockResolvedValueOnce(null);
    await checkGitRefresh(fixture.root);
    expect(mocks.update).not.toHaveBeenCalled();
    git(fixture.root, "checkout", "-b", "already-indexed");
    await checkGitRefresh(fixture.root);
    await vi.waitFor(() => expect(gitRefreshStatus(fixture.root)).toContain("synchronized"));
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.lastCall?.[3]).toMatchObject({
      projectId: gitProjectId(fixture.root, await readGitState(fixture.root)), allowCreate: false,
    });
  });

  it("returns the startup identity captured before an in-flight checkout change", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    const originalIdentity = gitProjectId(fixture.root, await readGitState(fixture.root));
    let release: () => void = () => {};
    mocks.update.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return success; });
    const resumed = resumeGitRefresh(fixture.root);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    git(fixture.root, "checkout", "-b", "during-startup");
    await checkGitRefresh(fixture.root);
    release();
    expect(await resumed).toBe(originalIdentity);
    expect(gitRefreshStatus(fixture.root)).toContain("FAILED");
  });

  it("allows a registered branch-aware checkout to acquire a new branch index", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    await synchronize();
    git(fixture.root, "checkout", "-b", "same-commit");
    const identity = gitProjectId(fixture.root, await readGitState(fixture.root));
    mocks.info.mockImplementation(async (collection) => collection === collectionName(identity) ? null : { pointsCount: 1 });
    await resumeGitRefresh(fixture.root);
    const target = mocks.update.mock.lastCall?.[3] as GitRefreshTarget;
    expect(target.projectId).toBe(identity);
    expect(target.allowCreate).toBe(true);
    expect(gitRefreshStatus(fixture.root)).toContain("refs/heads/same-commit");
  });

  it("keeps new-branch index creation pending when another commit follows a failed attempt", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    await synchronize();
    git(fixture.root, "checkout", "-b", "new-branch");
    const identity = gitProjectId(fixture.root, await readGitState(fixture.root));
    mocks.info.mockImplementation(async (collection) => collection === collectionName(identity) ? null : { pointsCount: 1 });
    mocks.update.mockRejectedValueOnce(new Error("Index creation failed"));
    await resumeGitRefresh(fixture.root);
    expect(gitRefreshStatus(fixture.root)).toContain("FAILED");

    git(fixture.root, "commit", "--allow-empty", "-m", "Next branch state");
    await resumeGitRefresh(fixture.root);
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(mocks.update.mock.lastCall?.[3]).toMatchObject({ allowCreate: true, projectId: identity });
    expect(gitRefreshStatus(fixture.root)).toContain("synchronized");
  });

  it.each([false, true])("does not auto-create a changed explicit project ID (pending branch: %s)", async (pendingBranch) => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    await synchronize();
    if (pendingBranch) {
      git(fixture.root, "checkout", "-b", "pending-branch");
      mocks.update.mockRejectedValueOnce(new Error("Index creation failed"));
      await resumeGitRefresh(fixture.root);
    }
    fs.writeFileSync(path.join(fixture.root, ".socraticode.json"), JSON.stringify({ projectId: "new-explicit-id" }));
    mocks.info.mockResolvedValue(null);
    await resumeGitRefresh(fixture.root);
    expect(mocks.update).toHaveBeenCalledTimes(pendingBranch ? 2 : 1);
    expect(gitRefreshStatus(fixture.root)).toContain("no existing index");
  });

  it("coalesces repeated checks, exposes pending reads, and retries the newest state after an in-flight checkout", async () => {
    await synchronize();
    let release: () => void = () => {};
    mocks.update.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); return success; });
    git(fixture.root, "commit", "--allow-empty", "-m", "First move");
    await checkGitRefresh(fixture.root);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2));
    expect(await withGitRefreshNotice(fixture.root, async () => "old results")).toMatch(/PENDING[\s\S]*old results/);
    git(fixture.root, "checkout", "-b", "newest");
    await Promise.all([checkGitRefresh(fixture.root), checkGitRefresh(fixture.root)]);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    release();
    await vi.waitFor(() => expect(gitRefreshStatus(fixture.root)).toContain("FAILED"));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    await synchronize();
    expect(mocks.update).toHaveBeenCalledTimes(3);
    expect(gitRefreshStatus(fixture.root)).toContain("refs/heads/newest");
  });

  it.each([
    { ...success, skipped: "Another process is already indexing this project, skipping" },
    { ...success, cancelled: true },
    new Error("Graph persistence failed"),
  ])("does not acknowledge a skipped, cancelled, or failed refresh", async (outcome) => {
    if (outcome instanceof Error) mocks.update.mockRejectedValueOnce(outcome);
    else mocks.update.mockResolvedValueOnce(outcome);
    await resumeGitRefresh(fixture.root);
    expect(gitRefreshStatus(fixture.root)).toMatch(/FAILED[\s\S]*stale/);
    await checkGitRefresh(fixture.root);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    await synchronize();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("keeps same-process contention pending and does not recreate a removed index", async () => {
    mocks.busy.mockReturnValue(true);
    await checkGitRefresh(fixture.root);
    expect(gitRefreshStatus(fixture.root)).toContain("PENDING");
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.busy.mockReturnValue(false);
    await synchronize();
    mocks.info.mockResolvedValue(null);
    git(fixture.root, "commit", "--allow-empty", "-m", "After removal");
    await resumeGitRefresh(fixture.root);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(gitRefreshStatus(fixture.root)).toContain("no existing index");
  });

  it("does not let an old collection lookup unregister a newer branch transition", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    await synchronize();
    let finishLookup: (value: null) => void = () => {};
    mocks.info.mockImplementationOnce(() => new Promise((resolve) => { finishLookup = resolve; }));
    git(fixture.root, "commit", "--allow-empty", "-m", "Old branch move");
    await checkGitRefresh(fixture.root);
    git(fixture.root, "checkout", "-b", "newest-branch");
    await checkGitRefresh(fixture.root);
    mocks.info.mockResolvedValue(null);
    finishLookup(null);
    await vi.waitFor(() => expect(gitRefreshStatus(fixture.root)).toContain("FAILED"));

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
    await resumeGitRefresh(fixture.root);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(gitRefreshStatus(fixture.root)).toContain("synchronized with refs/heads/newest-branch");
  });

  it("explicit updates establish freshness, while stop prevents their completion from resurrecting monitoring", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "off");
    const operation = await prepareGitIndex(fixture.root, new Set([".custom"]));
    await finishGitIndex(fixture.root, operation, success);
    expect(gitRefreshStatus(fixture.root)).toContain("synchronized");
    fs.writeFileSync(path.join(fixture.root, "main.ts"), "export const saved = 1;\n");
    await checkGitRefresh(fixture.root);
    expect(mocks.update).not.toHaveBeenCalled();
    stopGitRefresh(fixture.root);
    await finishGitIndex(fixture.root, operation, success);
    expect(gitRefreshStatus(fixture.root)).toContain("not monitoring");
  });

  it("reports Git observation failure and rechecks it on a later request", async () => {
    await synchronize();
    const originalPath = process.env.PATH;
    vi.stubEnv("PATH", path.join(fixture.root, "absent-bin"));
    await checkGitRefresh(fixture.root);
    expect(gitRefreshStatus(fixture.root)).toContain("could not be found");
    expect(gitRefreshStatus(fixture.root)).not.toContain("synchronized");
    expect(mocks.update).toHaveBeenCalledTimes(1);
    vi.stubEnv("PATH", originalPath);
    git(fixture.root, "commit", "--allow-empty", "-m", "Recovered fixture state");
    await synchronize();
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });
});
