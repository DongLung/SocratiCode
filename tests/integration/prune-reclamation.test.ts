// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * `codebase_prune` against a real Qdrant, under a prefix of its own.
 *
 * Everything the unit tests mock is exercised here for real: the collection
 * listing, the metadata scroll and its projection, the delete with `wait`,
 * and the re-read that decides whether the cleanup is complete. A second
 * SocratiCode installation is represented by a foreign prefix that must come
 * through untouched, and an unprefixed lookalike that must not be listed.
 *
 * Gated on Qdrant being reachable rather than on Docker: a shared store need
 * not be local, and this suite touches no embedding provider.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PREFIX = `prunetest${randomBytes(3).toString("hex")}_`;
const FOREIGN_PREFIX = `foreign${randomBytes(3).toString("hex")}_`;
process.env.QDRANT_COLLECTION_PREFIX = PREFIX;

const { QDRANT_COLLECTION_PREFIX, SOCRATICODE_VERSION } = await import("../../src/constants.js");
const { collectionName, contextCollectionName, graphCollectionName, projectIdFromPath } = await import("../../src/config.js");
const { GRAPH_INPUTS_VERSION } = await import("../../src/services/graph-inputs.js");
const { requestedIndexProfile } = await import("../../src/services/index-profile.js");
const { getClient, saveContextMetadata, saveGraphData, saveProjectMetadata, resetMetadataCollectionCache } = await import("../../src/services/qdrant.js");
const { ensureSymbolGraphCollections, saveSymbolGraphMeta } = await import("../../src/services/symbol-graph-store.js");
const { handleIndexTool } = await import("../../src/tools/index-tools.js");

const client = getClient();

async function qdrantReachable(): Promise<boolean> {
  try {
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

// REQUIRE_QDRANT=1 turns an unreachable backend into a failure: in CI a skip would read as a pass.
const requireQdrant = process.env.REQUIRE_QDRANT === "1";
const reachable = await qdrantReachable();
if (requireQdrant && !reachable) {
  throw new Error("REQUIRE_QDRANT=1 but Qdrant is not reachable. This regression must fail rather than skip.");
}

async function listNames(): Promise<string[]> {
  return (await client.getCollections()).collections.map((collection) => collection.name).sort();
}

async function createRawCollection(name: string): Promise<void> {
  await client.createCollection(name, { vectors: { size: 4, distance: "Cosine" } });
}

function tokenOf(report: string, identity: string): string {
  const block = report.split("\n\n").find((section) => section.startsWith(`Identity: ${identity}`));
  const line = block?.split("\n").find((candidate) => candidate.includes("Confirmation token:"));
  const token = line?.split("Confirmation token:")[1]?.trim();
  if (!token) throw new Error(`No confirmation token for ${identity} in report:\n${report}`);
  return token;
}

describe.skipIf(!reachable)("codebase_prune against a real store", () => {
  /** The identity being reclaimed; its directory is gone by the time the report runs. */
  let goneProject: string;
  let goneId: string;
  /** A live identity under the same prefix that must survive untouched. */
  let liveProject: string;
  let liveId: string;
  /** A pinned identity that begins with a family name; its symbol-graph names also read as another identity's. */
  let oddProject: string;
  const oddId = "context_docs";
  let ownedBefore: string[];
  const foreignCollections = [`${FOREIGN_PREFIX}codebase_alpha`, `${FOREIGN_PREFIX}socraticode_metadata`];
  const lookalike = "codebase_prunelookalike";

  beforeAll(async () => {
    expect(QDRANT_COLLECTION_PREFIX).toBe(PREFIX);
    resetMetadataCollectionCache();

    goneProject = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-prune-gone-"));
    liveProject = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-prune-live-"));
    oddProject = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-prune-odd-"));
    fs.writeFileSync(path.join(oddProject, ".socraticode.json"), JSON.stringify({ projectId: oddId }));
    goneId = projectIdFromPath(goneProject);
    liveId = projectIdFromPath(liveProject);
    expect(projectIdFromPath(oddProject)).toBe(oddId);

    const profile = requestedIndexProfile("code");
    const record = {
      version: GRAPH_INPUTS_VERSION,
      builtByVersion: SOCRATICODE_VERSION,
      capabilities: "aabbccddeeff0011",
      files: {},
      heads: {},
      presence: {},
      unreadable: [],
      unreadableDirectories: [],
      directories: {},
      settings: "00112233445566ff",
    };

    for (const [project, id] of [[goneProject, goneId], [liveProject, liveId], [oddProject, oddId]] as const) {
      await createRawCollection(collectionName(id));
      await createRawCollection(graphCollectionName(id));
      await createRawCollection(contextCollectionName(id));
      await ensureSymbolGraphCollections(id);
      await saveProjectMetadata(collectionName(id), project, 1, 1, new Map([["a.ts", "hash"]]), "completed", profile);
      await saveGraphData(graphCollectionName(id), project, { nodes: [], edges: [] }, record);
      await saveContextMetadata(contextCollectionName(id), project, [], requestedIndexProfile("context"));
      await saveSymbolGraphMeta(id, {
        projectId: id,
        symbolCount: 0,
        edgeCount: 0,
        fileCount: 0,
        unresolvedEdgePct: 0,
        builtAt: Date.now(),
        schemaVersion: 2,
      });
    }

    for (const name of [...foreignCollections, lookalike]) {
      await createRawCollection(name);
    }
    // A metadata point of a foreign installation sharing the same store, under our metadata collection's name.
    await client.upsert(`${FOREIGN_PREFIX}socraticode_metadata`, {
      wait: true,
      points: [{ id: 1, vector: [0, 0, 0, 0], payload: { collectionName: `${FOREIGN_PREFIX}codebase_alpha`, projectPath: "/elsewhere" } }],
    });

    ownedBefore = (await listNames()).filter((name) => name.startsWith(PREFIX));
    fs.rmSync(goneProject, { recursive: true, force: true });
  }, 60_000);

  afterAll(async () => {
    for (const name of await listNames()) {
      if (name.startsWith(PREFIX) || name.startsWith(FOREIGN_PREFIX) || name === lookalike) {
        await client.deleteCollection(name).catch(() => {});
      }
    }
    fs.rmSync(liveProject, { recursive: true, force: true });
    fs.rmSync(oddProject, { recursive: true, force: true });
  }, 60_000);

  it("reports both identities with their resources, and nothing foreign", async () => {
    const report = await handleIndexTool("codebase_prune", {});

    expect(report).toContain(`Identity: ${goneId}`);
    expect(report).toContain(`Identity: ${liveId}`);
    expect(report).toContain("absent-on-this-host");
    expect(report).toContain("present-on-this-host");
    expect(report).toContain("not proof that an identity is stale");
    for (const suffix of ["_symgraph_meta", "_symgraph_file", "_symgraph_index"]) {
      expect(report).toContain(`${PREFIX}${goneId}${suffix}`);
    }
    expect(report).toContain(`Metadata: ${PREFIX}codebase_${goneId}`);
    expect(report).toContain(`Metadata: ${PREFIX}codegraph_${goneId}`);
    expect(report).toContain(`Metadata: ${PREFIX}context_${goneId}`);
    expect(report).not.toContain(FOREIGN_PREFIX);
    expect(report).not.toContain(lookalike);
    expect(report).not.toContain("candidate");
    // The pinned identity's symbol-graph triple reads as `docs_symgraph_*` under `context_` too; the triple settles it.
    expect(report).toContain(`Identity: ${oddId}`);
    expect(report).not.toContain("Identity: docs_symgraph");
    expect(report).not.toContain("could not be attributed to one identity");

    expect(await listNames()).toEqual(expect.arrayContaining(ownedBefore));
  });

  it("refuses a stale token, an unacknowledged apply, and deletes nothing", async () => {
    const report = await handleIndexTool("codebase_prune", {});
    const token = tokenOf(report, goneId);

    expect(await handleIndexTool("codebase_prune", { apply: true, identity: goneId, confirmationToken: token })).toContain("acknowledgeNoRemoteWriters");
    expect(await handleIndexTool("codebase_prune", { apply: true, identity: goneId, confirmationToken: "stale", acknowledgeNoRemoteWriters: true })).toContain("inventory changed");

    expect(await listNames()).toEqual(expect.arrayContaining(ownedBefore));
  });

  it("deletes exactly the selected identity, leaves the rest, and repeats safely", async () => {
    const before = await listNames();
    const token = tokenOf(await handleIndexTool("codebase_prune", {}), goneId);

    const result = await handleIndexTool("codebase_prune", {
      apply: true,
      identity: goneId,
      confirmationToken: token,
      acknowledgeNoRemoteWriters: true,
    });

    expect(result).toContain(`Removed all inventoried resources for identity: ${goneId}`);
    expect(result).not.toContain("failed:");

    const after = await listNames();
    const goneResources = before.filter((name) => name.includes(goneId));
    expect(goneResources.length).toBe(6);
    for (const name of goneResources) expect(after).not.toContain(name);
    for (const name of before.filter((name) => !name.includes(goneId))) expect(after).toContain(name);

    const metadataPoints = await client.scroll(`${PREFIX}socraticode_metadata`, { limit: 100, with_payload: { include: ["collectionName"] }, with_vector: false });
    const remaining = metadataPoints.points.map((point) => String(point.payload?.collectionName));
    expect(remaining.some((name) => name.includes(goneId))).toBe(false);
    expect(remaining.filter((name) => name.includes(liveId)).length).toBe(3);
    expect(remaining.filter((name) => name.includes(oddId)).length).toBe(3);

    const report = await handleIndexTool("codebase_prune", {});
    expect(report).not.toContain(`Identity: ${goneId}`);
    expect(report).toContain(`Identity: ${liveId}`);

    const repeat = await handleIndexTool("codebase_prune", {
      apply: true,
      identity: goneId,
      confirmationToken: token,
      acknowledgeNoRemoteWriters: true,
    });
    expect(repeat).toContain("Nothing to delete");
    expect(await listNames()).toEqual(after);
  }, 60_000);

  it("holds back both candidates of a name two identities claim, and stays ambiguous across reads", async () => {
    // A family metadata point now also claims the pinned identity's symbol-graph meta collection.
    const contested = `${PREFIX}${oddId}_symgraph_meta`;
    await saveProjectMetadata(contested, "/elsewhere/docs_symgraph_meta", 1, 1, new Map(), "completed", requestedIndexProfile("code"));
    const before = await listNames();

    const report = await handleIndexTool("codebase_prune", {});
    expect(report).toContain(`${contested} — name fits ${oddId} (symgraph) or docs_symgraph_meta (family)`);
    for (const identity of [oddId, "docs_symgraph_meta"]) {
      expect(report).toContain(`Identity: ${identity}`);
      const token = tokenOf(report, identity);
      const result = await handleIndexTool("codebase_prune", { apply: true, identity, confirmationToken: token, acknowledgeNoRemoteWriters: true });
      expect(result).toContain(`Refusing to delete ${identity}: its identity cannot be established safely`);
    }

    expect(await listNames()).toEqual(before);
    const points = await client.scroll(`${PREFIX}socraticode_metadata`, { limit: 100, with_payload: { include: ["collectionName"] }, with_vector: false });
    expect(points.points.some((point) => point.payload?.collectionName === contested)).toBe(true);
    expect(await handleIndexTool("codebase_prune", {})).toContain(`${contested} — name fits`);
  }, 60_000);
});
