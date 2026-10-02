// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { collectionName, contextCollectionName, graphCollectionName } from "../config.js";
import { reclaimProjectIdentity } from "../tools/index-tools.js";
import { assertLocalCleanupStore, assertLocalIndexRetired, automaticCleanupEnabled, parseLocalIndexOwnership } from "./local-index-ownership.js";
import { logger } from "./logger.js";
import { getProjectReclamationInventory, type ProjectReclamationEntry } from "./qdrant.js";

let timer: ReturnType<typeof setInterval> | null = null;
let pending: Promise<void> | null = null;
let stopped = true;

async function retirementRefusal(entry: ProjectReclamationEntry): Promise<string | null> {
  if (entry.requiresManualInspection) return entry.manualInspectionReasons.join("; ");
  if (entry.inProgress) return "a metadata record reports indexing in progress";
  if (entry.metadataRecords.length === 0) return "no local ownership metadata; report-only";
  const records = entry.metadataRecords.map((record) => parseLocalIndexOwnership(record.localIndexOwnership));
  const ownership = records[0];
  if (!ownership || records.some((record) => !record)) {
    const refused = entry.metadataRecords.map((record) => record.localIndexOwnership).find((value) => value && typeof value === "object" && "refusal" in value);
    return refused ? `ownership refused: ${String((refused as { refusal: unknown }).refusal)}; report-only` : "legacy or incomplete local ownership metadata; report-only";
  }
  if (records.some((record) => JSON.stringify(record) !== JSON.stringify(ownership))) return "metadata records disagree about local ownership";
  if (ownership.identity !== entry.identity || entry.metadataRecords.some((record) => record.projectPath !== ownership.projectPath)) return "the recorded identity/path association changed";
  for (const name of [collectionName(entry.identity), graphCollectionName(entry.identity), contextCollectionName(entry.identity)]) {
    if (entry.resourceCollections.includes(name) && !entry.metadataRecords.some((record) => record.collectionName === name)) return "an index resource has no ownership metadata; report-only";
  }
  try {
    await assertLocalIndexRetired(ownership);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One explicit-local sweep, returning every deletion/refusal instead of treating partial cleanup as success. */
export async function runAutomaticCleanup(mayContinue: () => boolean = () => true): Promise<string[]> {
  if (!automaticCleanupEnabled()) return [];
  assertLocalCleanupStore();
  const inventory = await getProjectReclamationInventory();
  const results: string[] = [];
  for (const entry of inventory.entries) {
    if (!mayContinue()) break;
    const refusal = await retirementRefusal(entry);
    if (refusal) {
      results.push(`Retained identity ${entry.identity}: ${refusal}.`);
      continue;
    }
    results.push(await reclaimProjectIdentity(entry.identity, entry.confirmationToken, async (fresh) => mayContinue() ? retirementRefusal(fresh) : "automatic cleanup stopped for shutdown"));
  }
  for (const record of inventory.unrecognisedMetadata) results.push(`Retained unrecognised metadata point ${record.pointId}: ${record.reason}.`);
  for (const collection of inventory.unattributedCollections) results.push(`Retained unattributed collection ${collection.name}: ${collection.reason}.`);
  return results;
}

/** Run at MCP startup and every minute, without provisioning Qdrant or overlapping sweeps. */
export function startAutomaticCleanup(): void {
  if (!automaticCleanupEnabled() || timer) return;
  stopped = false;
  const sweep = () => {
    if (stopped || pending) return;
    pending = runAutomaticCleanup(() => !stopped).then((results) => {
      for (const result of results) {
        if (result.startsWith("Removed")) logger.info("Automatic index cleanup", { result });
        else logger.warn("Automatic index cleanup", { result });
      }
    }).catch((error) => {
      logger.error("Automatic index cleanup failed; cleanup is not complete", { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { pending = null; });
  };
  timer = setInterval(sweep, 60_000);
  timer.unref();
  sweep();
}

/** Cancel future deletion and drain the current sweep before writer locks are released. */
export async function stopAutomaticCleanup(): Promise<void> {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  await pending;
}
