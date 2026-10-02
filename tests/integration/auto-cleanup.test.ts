// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitFixture, git } from "../helpers/git.js";

const prefix = `autocleanup${randomBytes(6).toString("hex")}_`;
process.env.QDRANT_COLLECTION_PREFIX = prefix;
// Exercise managed-local eligibility against the test's isolated loopback Qdrant.
vi.mock("../../src/constants.js", async (original) => ({ ...await original<Record<string, unknown>>(), QDRANT_MODE: "managed" }));

const { collectionName, contextCollectionName, graphCollectionName, projectIdFromPath } = await import("../../src/config.js");
const { SOCRATICODE_VERSION, QDRANT_URL, QDRANT_HOST, QDRANT_PORT } = await import("../../src/constants.js");
const { runAutomaticCleanup } = await import("../../src/services/auto-cleanup.js");
const { GRAPH_INPUTS_VERSION } = await import("../../src/services/graph-inputs.js");
const { requestedIndexProfile } = await import("../../src/services/index-profile.js");
const { releaseAllLocks, isProjectIdentityLocked } = await import("../../src/services/lock.js");
const { ensureCollection, getClient, getProjectReclamationInventory, resetMetadataCollectionCache, saveContextMetadata, saveGraphData, saveProjectMetadata } = await import("../../src/services/qdrant.js");
const { WRITER_OPERATIONS } = await import("../../src/services/reclamation-barrier.js");
const { ensureSymbolGraphCollections } = await import("../../src/services/symbol-graph-store.js");
const client = getClient();
let reachable = false;
try { await client.getCollections(); reachable = true; } catch (error) {
  if (process.env.REQUIRE_QDRANT === "1") throw error;
}

describe.skipIf(!reachable)("automatic cleanup through real Git, Qdrant and writer barriers", () => {
  let fixture: ReturnType<typeof createGitFixture>;
  const identities = new Set<string>();
  beforeEach(() => {
    fixture = createGitFixture();
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", "local");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
    vi.spyOn(os, "homedir").mockReturnValue(path.join(fixture.root, ".owner-home"));
    resetMetadataCollectionCache();
  });
  afterEach(async () => {
    await releaseAllLocks();
    vi.restoreAllMocks();
    for (const { name } of (await client.getCollections()).collections) {
      if (name.startsWith(prefix)) await client.deleteCollection(name);
    }
    for (const identity of identities) {
      for (const operation of ["prune", ...WRITER_OPERATIONS]) fs.rmSync(path.join(os.tmpdir(), "socraticode-locks", `${identity}-${operation}`), { force: true });
    }
    identities.clear();
    vi.unstubAllEnvs();
    fixture.cleanup();
  });
  afterAll(() => { delete process.env.QDRANT_COLLECTION_PREFIX; });

  async function index(project: string, status: "completed" | "in-progress" = "completed", allResources = false): Promise<string> {
    const identity = projectIdFromPath(project);
    identities.add(identity);
    await ensureCollection(collectionName(identity));
    await saveProjectMetadata(collectionName(identity), project, 1, 1, new Map([["main.ts", "synthetic"]]), status, requestedIndexProfile("code"));
    if (allResources) {
      await ensureCollection(contextCollectionName(identity));
      await saveContextMetadata(contextCollectionName(identity), project, [], requestedIndexProfile("context"));
      await saveGraphData(graphCollectionName(identity), project, { nodes: [], edges: [] }, {
        version: GRAPH_INPUTS_VERSION, builtByVersion: SOCRATICODE_VERSION, capabilities: "aabbccddeeff0011",
        files: {}, heads: {}, presence: {}, unreadable: [], unreadableDirectories: [], directories: {}, settings: "00112233445566ff",
      });
      await ensureSymbolGraphCollections(identity);
    }
    return identity;
  }
  async function worktree(allResources = false, status: "completed" | "in-progress" = "completed") {
    const checkout = path.join(fixture.root, "worktrees", "topic");
    fs.mkdirSync(path.dirname(checkout));
    git(fixture.root, "worktree", "add", "-b", "topic", checkout);
    return { checkout, identity: await index(checkout, status, allResources) };
  }
  async function exists(identity: string) {
    return (await getProjectReclamationInventory()).entries.some((entry) => entry.identity === identity);
  }

  it("removes only a verified retired worktree's resources and metadata, and repeats safely", async () => {
    const main = await index(fixture.root);
    const { checkout, identity } = await worktree(true);
    git(fixture.root, "worktree", "remove", checkout);
    const before = await getProjectReclamationInventory();
    expect(before.entries.find((entry) => entry.identity === identity)?.metadataRecords.every((record) => record.localIndexOwnership)).toBe(true);
    const results = await runAutomaticCleanup();
    expect(results.join("\n")).toContain(`Removed all inventoried resources for identity: ${identity}`);
    expect(await exists(identity)).toBe(false);
    expect(await exists(main)).toBe(true);
    expect(git(fixture.root, "branch", "--list", "topic")).toContain("topic");
    expect(fs.existsSync(fixture.root)).toBe(true);
    expect((await runAutomaticCleanup()).join("\n")).not.toContain("Removed");
  });

  it("retains merged/switched branches and removes only the deleted branch identity", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    const main = await index(fixture.root);
    git(fixture.root, "checkout", "-b", "topic");
    const identity = await index(fixture.root);
    git(fixture.root, "checkout", "main");
    git(fixture.root, "merge", "topic");
    expect((await runAutomaticCleanup()).join("\n")).not.toContain("Removed");
    git(fixture.root, "branch", "-D", "topic");
    expect((await runAutomaticCleanup()).join("\n")).toContain(`Removed all inventoried resources for identity: ${identity}`);
    expect(await exists(main)).toBe(true);
  });

  it("keeps a non-branch-aware worktree's original ownership through branch switches and updates", async () => {
    const { checkout, identity } = await worktree();
    const before = (await getProjectReclamationInventory()).entries.find((entry) => entry.identity === identity)?.metadataRecords[0]?.localIndexOwnership;
    git(checkout, "checkout", "-b", "switched-topic");
    await index(checkout);
    const after = (await getProjectReclamationInventory()).entries.find((entry) => entry.identity === identity)?.metadataRecords[0]?.localIndexOwnership;
    expect(after).toEqual(before);
    expect((await runAutomaticCleanup()).join("\n")).not.toContain("Removed");
    git(fixture.root, "worktree", "remove", checkout);
    expect((await runAutomaticCleanup()).join("\n")).toContain(`Removed all inventoried resources for identity: ${identity}`);
    expect(git(fixture.root, "branch", "--list", "topic", "switched-topic")).toContain("switched-topic");
  });

  it("does nothing when disabled and never adopts legacy metadata on a later update", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", "off");
    const { checkout, identity } = await worktree();
    expect(await runAutomaticCleanup()).toEqual([]);
    expect(fs.existsSync(path.join(fixture.root, ".owner-home"))).toBe(false);
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", "local");
    await index(checkout);
    git(fixture.root, "worktree", "remove", checkout);
    expect((await runAutomaticCleanup()).join("\n")).toContain("report-only");
    expect(await exists(identity)).toBe(true);
  });

  it("retains a missing but registered worktree, incomplete writers, orphan resources and foreign ownership", async () => {
    const { checkout, identity } = await worktree();
    fs.rmSync(checkout, { recursive: true });
    expect((await runAutomaticCleanup()).join("\n")).not.toContain("Removed");
    git(fixture.root, "worktree", "prune", "--expire", "now");
    const entry = (await getProjectReclamationInventory()).entries.find((candidate) => candidate.identity === identity);
    const point = entry?.metadataRecords[0];
    expect(point).toBeDefined();
    await client.setPayload(`${prefix}socraticode_metadata`, { wait: true, points: [point?.pointId as string], payload: { indexingStatus: "in-progress" } });
    expect((await runAutomaticCleanup()).join("\n")).toContain("indexing in progress");
    await client.setPayload(`${prefix}socraticode_metadata`, { wait: true, points: [point?.pointId as string], payload: { indexingStatus: "completed" } });
    await client.createCollection(contextCollectionName(identity), { vectors: { size: 4, distance: "Cosine" } });
    expect((await runAutomaticCleanup()).join("\n")).toContain("no ownership metadata");
    await client.deleteCollection(contextCollectionName(identity));
    await client.setPayload(`${prefix}socraticode_metadata`, { wait: true, points: [point?.pointId as string], payload: {
      localIndexOwnership: { ...(point?.localIndexOwnership as Record<string, unknown>), ownerId: "00000000-0000-4000-8000-000000000000" },
    } });
    expect((await runAutomaticCleanup()).join("\n")).toContain("another local installation");
    expect(await exists(identity)).toBe(true);
  });

  it("refuses a real writer in another process and deletes only after that writer releases", async () => {
    const { checkout, identity } = await worktree();
    git(fixture.root, "worktree", "remove", checkout);
    const script = `(async () => {
      const { acquireIdentityLock, releaseAllLocks } = await import(${JSON.stringify(new URL("../../src/services/lock.ts", import.meta.url).href)});
      if (!await acquireIdentityLock(${JSON.stringify(identity)}, "watch")) throw new Error("fixture writer could not acquire its lock");
      process.stdout.write("held");
      await new Promise(resolve => process.stdin.once("data", resolve));
      await releaseAllLocks();
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
    const writer = spawn(process.execPath, [fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)), "--eval", script], {
      env: { ...process.env, SOCRATICODE_LOG_LEVEL: "error" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let errors = "";
    writer.stderr.on("data", (data) => { errors += String(data); });
    await new Promise<void>((resolve, reject) => {
      writer.stdout.once("data", () => resolve());
      writer.once("error", reject);
      writer.once("exit", () => reject(new Error(`fixture writer exited before locking: ${errors}`)));
    });
    try {
      expect((await runAutomaticCleanup()).join("\n")).toContain("watch lock is held");
      expect(await exists(identity)).toBe(true);
    } finally {
      const exit = once(writer, "exit");
      writer.stdin.end("release");
      await exit;
    }
    expect((await runAutomaticCleanup()).join("\n")).toContain(`Removed all inventoried resources for identity: ${identity}`);
  });

  it("reports partial failures, preserves ownership, and retries only the remaining owned resources", async () => {
    const { checkout, identity } = await worktree(true);
    git(fixture.root, "worktree", "remove", checkout);
    const remove = client.deleteCollection.bind(client);
    const deletion = vi.spyOn(client, "deleteCollection").mockImplementation(async (name) => {
      if (name === collectionName(identity)) throw new Error("synthetic collection deletion failure");
      return remove(name);
    });
    const first = (await runAutomaticCleanup()).join("\n");
    expect(first).toContain("incomplete");
    expect(first).toContain("synthetic collection deletion failure");
    expect(first).toContain("ownership metadata retained");
    const remaining = (await getProjectReclamationInventory()).entries.find((entry) => entry.identity === identity);
    expect(remaining?.resourceCollections).toEqual([collectionName(identity)]);
    expect(remaining?.metadataRecords).toHaveLength(3);
    deletion.mockRestore();
    expect((await runAutomaticCleanup()).join("\n")).toContain(`Removed all inventoried resources for identity: ${identity}`);
    expect(await exists(identity)).toBe(false);
  });

  it("reuses persisted ownership across real MCP restarts, reports deletion and releases barriers on shutdown", async () => {
    const { checkout, identity } = await worktree();
    const entrypoint = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
    if (!fs.existsSync(entrypoint)) throw new Error("Run npm run build before the MCP cleanup integration test");
    const notifications: string[] = [];
    async function launch() {
      const mcp = new Client({ name: "automatic-cleanup-fixture", version: "1.0.0" });
      mcp.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { notifications.push(String(notification.params.data)); });
      const transport = new StdioClientTransport({
        command: process.execPath, args: [entrypoint], cwd: fixture.root, stderr: "pipe",
        env: {
          HOME: path.join(fixture.root, ".owner-home"), USERPROFILE: path.join(fixture.root, ".owner-home"),
          TMPDIR: os.tmpdir(), TMP: os.tmpdir(), TEMP: os.tmpdir(),
          SOCRATICODE_AUTO_CLEANUP: "local", SOCRATICODE_AUTO_RESUME: "off", SOCRATICODE_WATCHER: "off",
          SOCRATICODE_PROJECT_ID: "", SOCRATICODE_BRANCH_AWARE: "false", QDRANT_COLLECTION_PREFIX: prefix,
          QDRANT_MODE: "managed", QDRANT_URL: QDRANT_URL ?? `http://${QDRANT_HOST}:${QDRANT_PORT}`,
        },
      });
      await mcp.connect(transport);
      return mcp;
    }
    const first = await launch();
    try {
      await vi.waitFor(() => expect(notifications.some((message) => message.includes(`Retained identity ${identity}`))).toBe(true), { timeout: 20_000, interval: 250 });
      expect(await exists(identity)).toBe(true);
    } finally { await first.close(); }
    git(fixture.root, "worktree", "remove", checkout);
    const second = await launch();
    try {
      await vi.waitFor(async () => {
        expect(await exists(identity)).toBe(false);
        expect(notifications.some((message) => message.includes(`Removed all inventoried resources for identity: ${identity}`))).toBe(true);
      }, { timeout: 20_000, interval: 250 });
    } finally { await second.close(); }
    for (const operation of ["prune", ...WRITER_OPERATIONS]) expect(await isProjectIdentityLocked(identity, operation)).toBe(false);
  });
});
