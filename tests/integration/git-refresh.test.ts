// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectionName, projectIdFromPath } from "../../src/config.js";
import { getExistingGraph } from "../../src/services/code-graph.js";
import { checkGitRefresh, gitRefreshStatus, stopAllGitRefreshes } from "../../src/services/git-refresh.js";
import { hashContent, isIndexingInProgress, removeProjectIndex } from "../../src/services/indexer.js";
import { getCollectionInfo, loadProjectHashes } from "../../src/services/qdrant.js";
import { autoResumeIndexedProjects } from "../../src/services/startup.js";
import { isWatching } from "../../src/services/watcher.js";
import { handleGraphTool } from "../../src/tools/graph-tools.js";
import { handleIndexTool } from "../../src/tools/index-tools.js";
import { handleQueryTool } from "../../src/tools/query-tools.js";
import { isDockerAvailable } from "../helpers/fixtures.js";
import { createGitFixture, git } from "../helpers/git.js";
import { waitForOllama, waitForQdrant } from "../helpers/setup.js";

describe.skipIf(!isDockerAvailable())("Git refresh with real Git, embeddings, Qdrant, and graphs", () => {
  let fixture: ReturnType<typeof createGitFixture>;
  const identities = new Set<string>();
  const identity = () => { const id = projectIdFromPath(fixture.root); identities.add(id); return id; };
  const hashes = () => loadProjectHashes(collectionName(identity()));
  async function settled(ref: string) {
    await vi.waitFor(() => {
      expect(gitRefreshStatus(fixture.root)).toContain(`synchronized with ${ref}`);
      expect(isIndexingInProgress(fixture.root)).toBe(false);
    }, { timeout: 90_000, interval: 300 });
  }

  beforeAll(async () => {
    if (!await waitForQdrant(120_000)) throw new Error("Qdrant did not become ready");
    if (!await waitForOllama()) throw new Error("Ollama did not become ready");
    vi.stubEnv("SOCRATICODE_WATCHER", "git");
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "off");
    vi.stubEnv("SOCRATICODE_AUTO_RESUME_PROJECTS", "");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    fixture = createGitFixture();
  }, 150_000);

  afterAll(async () => {
    stopAllGitRefreshes();
    if (fixture) {
      await vi.waitFor(() => expect(isIndexingInProgress(fixture.root)).toBe(false), { timeout: 90_000 });
      // Only identities created by this synthetic fixture are deleted.
      for (const id of identities) {
        vi.stubEnv("SOCRATICODE_PROJECT_ID", id);
        await removeProjectIndex(fixture.root);
      }
      fixture.cleanup();
    }
    vi.unstubAllEnvs();
  }, 120_000);

  it("leaves a new project unindexed and preserves explicit indexing without a native watcher", async () => {
    const status = await handleQueryTool("codebase_status", { projectPath: fixture.root });
    expect(status).toContain("no existing index");
    expect(await getCollectionInfo(collectionName(identity()))).toBeNull();
    const started = await handleIndexTool("codebase_index", { projectPath: fixture.root });
    expect(started).toContain("Indexing started");
    await settled("refs/heads/main");
    expect((await hashes())?.has("main.ts")).toBe(true);
    expect(await getExistingGraph(fixture.root)).not.toBeNull();
    expect(isWatching(fixture.root)).toBe(false);
    expect(await handleIndexTool("codebase_watch", { projectPath: fixture.root, action: "start" })).toContain("disabled by SOCRATICODE_WATCHER=git");
    expect(isWatching(fixture.root)).toBe(false);
  });

  it("polls commits without tool traffic and indexes working-tree content, not only committed content", async () => {
    const oldHashes = await hashes();
    const source = "export function committedGreeting() { return 'git_refresh_working_tree_marker'; }\n";
    fs.writeFileSync(path.join(fixture.root, "main.ts"), source);
    await checkGitRefresh(fixture.root);
    expect(await hashes()).toEqual(oldHashes);
    git(fixture.root, "commit", "-am", "Commit fixture update");
    const dirty = "export function uncommittedHelper() { return 'git_refresh_unsaved_marker'; }\n";
    fs.writeFileSync(path.join(fixture.root, "dirty.ts"), dirty);
    // No query/status trigger: exercise the actual polling timer.
    await vi.waitFor(async () => expect((await hashes())?.get("dirty.ts")).toBe(hashContent(dirty)), { timeout: 90_000, interval: 500 });
    await settled("refs/heads/main");
    const search = await handleQueryTool("codebase_search", { projectPath: fixture.root, query: "git_refresh_working_tree_marker", minScore: 0 });
    expect(search).toContain("committedGreeting");
    expect(search).toContain("synchronized");
    const symbols = await handleGraphTool("codebase_symbols", { projectPath: fixture.root, query: "uncommittedHelper" });
    expect(symbols).toContain("uncommittedHelper");
    expect(isWatching(fixture.root)).toBe(false);
    fs.rmSync(path.join(fixture.root, "dirty.ts"));
  });

  it("keeps branch-specific collections and cached graphs separate, including same-SHA switches and detached HEAD", async () => {
    stopAllGitRefreshes();
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    const mainIdentity = identity();
    await handleIndexTool("codebase_update", { projectPath: fixture.root });
    await settled("refs/heads/main");
    const mainHashes = await hashes();
    git(fixture.root, "checkout", "-b", "feature");
    const featureIdentity = identity();
    expect(featureIdentity).not.toBe(mainIdentity);
    const pending = await handleGraphTool("codebase_graph_stats", { projectPath: fixture.root });
    expect(pending).toMatch(/PENDING|Repeat the request/);
    await settled("refs/heads/feature");
    expect(await hashes()).toEqual(mainHashes);
    fs.writeFileSync(path.join(fixture.root, "feature.ts"), "export function featureOnly() { return 2; }\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "Feature fixture");
    await checkGitRefresh(fixture.root);
    await settled("refs/heads/feature");
    expect((await getExistingGraph(fixture.root))?.nodes.some((n) => n.relativePath === "feature.ts")).toBe(true);
    git(fixture.root, "checkout", "main");
    await checkGitRefresh(fixture.root);
    await settled("refs/heads/main");
    expect((await getExistingGraph(fixture.root))?.nodes.some((n) => n.relativePath === "feature.ts")).toBe(false);
    expect(await loadProjectHashes(collectionName(mainIdentity))).toEqual(mainHashes);
    expect((await loadProjectHashes(collectionName(featureIdentity)))?.has("feature.ts")).toBe(true);
    git(fixture.root, "checkout", "--detach");
    identity();
    await checkGitRefresh(fixture.root);
    await settled("detached HEAD");
  });

  it("respects restart catch-up policy and resumes the existing index without a reset", async () => {
    stopAllGitRefreshes();
    const original = await hashes();
    fs.writeFileSync(path.join(fixture.root, "offline.ts"), "export const offlineChange = true;\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "Offline fixture");
    await autoResumeIndexedProjects(fixture.root);
    expect(await hashes()).toEqual(original);
    expect(gitRefreshStatus(fixture.root)).toContain("not monitoring");
    const status = await handleQueryTool("codebase_status", { projectPath: fixture.root });
    expect(status).toContain("unverified");
    expect(await hashes()).toEqual(original);
    stopAllGitRefreshes();
    vi.stubEnv("SOCRATICODE_AUTO_RESUME", "");
    await autoResumeIndexedProjects(fixture.root);
    await settled("detached HEAD");
    expect((await hashes())?.has("offline.ts")).toBe(true);
    expect(isWatching(fixture.root)).toBe(false);
  });
});
