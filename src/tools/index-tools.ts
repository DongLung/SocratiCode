// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import path from "node:path";
import { collectionName, projectIdFromPath } from "../config.js";
import { getWatcherMode, mergeExtraExtensions, QDRANT_MODE } from "../constants.js";
import { awaitGraphBuild, getGraphBuildInProgressProjects, invalidateGraphCache, invalidateGraphCacheForIdentity, isGraphBuildInProgress } from "../services/code-graph.js";
import { getContextIndexingInProgressProjects } from "../services/context-artifacts.js";
import type { InfraProgressCallback } from "../services/docker.js";
import { ensureQdrantReady, isDockerAvailable } from "../services/docker.js";
import { ensureEffectiveEmbeddingReady } from "../services/index-profile.js";
import { getIndexingInProgressProjects, getIndexingProgress, indexProject, invalidateProjectHashesForIdentity, isIndexingInProgress, removeProjectIndex, requestCancellation, setIndexingProgress, updateProjectIndex } from "../services/indexer.js";
import { isProjectIdentityLocked, isProjectLocked, terminateLockHolder } from "../services/lock.js";
import { logger } from "../services/logger.js";
import {
  getProjectReclamationInventory,
  loadEffectiveIndexProfileForCollection,
  type ProjectReclamationEntry,
  removeProjectReclamationEntry,
} from "../services/qdrant.js";
import { acquireReclamationBarrier, WRITER_OPERATIONS } from "../services/reclamation-barrier.js";
import { dropSymbolGraphCache } from "../services/symbol-graph-cache.js";
import { resetSymbolGraphCollectionCache } from "../services/symbol-graph-store.js";
import { getWatchedProjects, isWatching, startWatching, startWatchingAutomatically, stopWatching } from "../services/watcher.js";

const DOCKER_NOT_AVAILABLE_MESSAGE = [
  "❌ Docker is not available.",
  "",
  "SocratiCode requires Docker to manage the Qdrant container.",
  "",
  "To fix this:",
  "  1. Install Docker Desktop from https://www.docker.com/products/docker-desktop/",
  "  2. Make sure Docker Desktop is running (check for the whale icon in your system tray/menu bar)",
  "  3. Try this command again",
  "",
  "Alternatively, set QDRANT_MODE=external and point QDRANT_URL at a remote Qdrant server.",
  "",
  "Run codebase_health for a full infrastructure diagnostic.",
].join("\n");

async function ensureInfrastructure(
  projectPath: string,
  onProgress?: InfraProgressCallback,
): Promise<string[]> {
  const messages: string[] = [];

  const docker = await ensureQdrantReady(onProgress);
  if (docker.pulled) messages.push("Pulled Qdrant Docker image.");
  if (docker.started) messages.push("Started Qdrant container.");

  const resolvedPath = path.resolve(projectPath);
  const collection = collectionName(projectIdFromPath(resolvedPath));
  const profile = await loadEffectiveIndexProfileForCollection(collection);
  const readiness = await ensureEffectiveEmbeddingReady(profile, onProgress);
  if (readiness.imagePulled) messages.push("Pulled Ollama Docker image.");
  if (readiness.containerStarted) messages.push("Started Ollama container.");
  if (readiness.modelPulled) messages.push(`Pulled ${profile.embedding.model} model.`);

  return messages;
}

function formatIndexingInProgressMessage(resolvedPath: string, requestedTool: string): string {
  const progress = getIndexingProgress(resolvedPath);
  const lines = [
    `⚠ Indexing is already in progress for: ${resolvedPath}`,
    `Cannot run ${requestedTool} — please wait for the current operation to finish.`,
    "",
  ];

  if (progress) {
    lines.push(`Operation: ${progress.type === "full-index" ? "Full index" : "Incremental update"}`);
    lines.push(`Phase: ${progress.phase}`);
  }

  lines.push("", "Use codebase_status to check current indexing state.");
  return lines.join("\n");
}

function formatPruneInventory(): Promise<string> {
  return getProjectReclamationInventory().then((inventory) => {
    if (inventory.entries.length === 0 && inventory.unrecognisedMetadata.length === 0) {
      return "No stored project identities found.";
    }
    const lines = [
      "Stored project inventory:",
      "",
      "Path state is local observation only. An absent path on this host is not proof that an identity is stale: in a shared store the path may exist only where the index was written.",
      "Apply requires the exact identity, its confirmation token, and acknowledgeNoRemoteWriters: true.",
    ];
    for (const entry of inventory.entries) {
      lines.push("", `Identity: ${entry.identity}`);
      lines.push(`  Path: ${entry.projectPath ?? "(unknown)"}`);
      lines.push(`  Path state: ${entry.pathState}`);
      if (entry.canonicalPath) lines.push(`  Canonical path: ${entry.canonicalPath}`);
      lines.push(`  Collections: ${entry.resourceCollections.join(", ") || "(none)"}`);
      for (const record of entry.metadataRecords) {
        const facts = [
          record.indexingStatus ? `status=${record.indexingStatus}` : null,
          record.lastIndexedAt ? `indexed=${record.lastIndexedAt}` : null,
          record.lastBuiltAt ? `built=${record.lastBuiltAt}` : null,
          record.builtByVersion ? `by=${record.builtByVersion}` : null,
          record.projectPath && record.projectPath !== entry.projectPath ? `path=${record.projectPath}` : null,
        ].filter((fact) => fact !== null);
        lines.push(`  Metadata: ${record.collectionName} [point ${record.pointId}]${facts.length ? ` ${facts.join(" ")}` : ""}`);
      }
      if (entry.inProgress) lines.push("  Indexing in progress: a metadata record is mid-write; deletion is refused until it completes");
      if (entry.possibleSuperseded) lines.push("  Advisory: possible-superseded (another identity has this canonical path)");
      if (entry.requiresManualInspection) lines.push("  Manual inspection required: conflicting or incomplete metadata");
      lines.push(`  Confirmation token: ${entry.confirmationToken}`);
    }
    if (inventory.unrecognisedMetadata.length > 0) {
      lines.push("", `${inventory.unrecognisedMetadata.length} metadata point${inventory.unrecognisedMetadata.length === 1 ? "" : "s"} could not be attributed to an identity and cannot be deleted by this tool:`);
      for (const unrecognised of inventory.unrecognisedMetadata) {
        lines.push(`  point ${unrecognised.pointId}: collectionName=${unrecognised.collectionName ?? "(none)"} projectPath=${unrecognised.projectPath ?? "(none)"} — ${unrecognised.reason}`);
      }
    }
    return lines.join("\n");
  });
}

/** Why a fresh inventory forbids deleting the identity, or null; activity is judged separately. */
function pruneRefusal(entry: ProjectReclamationEntry | undefined, identity: string, confirmationToken: string): string | null {
  if (!entry) return null;
  if (entry.confirmationToken !== confirmationToken) {
    return `Refusing to delete ${identity}: the inventory changed. Run codebase_prune again and use its new confirmation token.`;
  }
  if (entry.requiresManualInspection) {
    return `Refusing to delete ${identity}: its identity cannot be established safely from the stored metadata.`;
  }
  if (entry.inProgress) {
    return `Refusing to delete ${identity}: a metadata record reports indexing in progress.`;
  }
  return null;
}

function identityOfPath(projectPath: string): string | null {
  try {
    return projectIdFromPath(projectPath);
  } catch {
    return null;
  }
}

/** What is writing to the identity, or null. Cross-process locks are read only before the barrier, which then holds them. */
async function reclamationActivity(identity: string, storedPath: string | null, crossProcess: boolean): Promise<string | null> {
  const resolvedStored = storedPath === null ? null : path.resolve(storedPath);
  // Matched by stored path too, so a path-hash entry whose directory is now pinned is still caught.
  const touches = (paths: string[]) => paths.some((candidate) => {
    const resolved = path.resolve(candidate);
    return resolved === resolvedStored || identityOfPath(resolved) === identity;
  });
  if (touches(getIndexingInProgressProjects())) return "indexing is in progress";
  if (touches(getWatchedProjects())) return "a watcher is running";
  if (touches(getGraphBuildInProgressProjects())) return "a graph build is in progress";
  if (touches(getContextIndexingInProgressProjects())) return "context artifacts are being indexed";
  if (crossProcess) {
    for (const operation of WRITER_OPERATIONS) {
      if (await isProjectIdentityLocked(identity, operation)) return `its ${operation} lock is held by another process`;
    }
  }
  return null;
}

async function findPruneEntry(identity: string): Promise<ProjectReclamationEntry | undefined> {
  return (await getProjectReclamationInventory()).entries.find((candidate) => candidate.identity === identity);
}

export async function handleIndexTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const projectPath = (args.projectPath as string) || process.cwd();
  const progressMessages: string[] = [];
  const onProgress = (msg: string) => {
    progressMessages.push(msg);
    logger.info(msg, { tool: name, projectPath });
  };

  switch (name) {
    case "codebase_index": {
      // Concurrency guard: if already indexing, return progress
      const resolved = path.resolve(projectPath);
      if (isIndexingInProgress(resolved)) {
        return formatIndexingInProgressMessage(resolved, "codebase_index");
      }

      // Check Docker availability before anything else (managed mode only)
      if (QDRANT_MODE === "managed" && !(await isDockerAvailable())) {
        return DOCKER_NOT_AVAILABLE_MESSAGE;
      }

      // Set up infrastructure progress tracking so codebase_status shows what's happening
      setIndexingProgress(resolved, {
        type: "full-index",
        startedAt: Date.now(),
        filesTotal: 0,
        filesProcessed: 0,
        phase: "preparing infrastructure",
      });

      const infraProgress: InfraProgressCallback = (msg) => {
        setIndexingProgress(resolved, {
          type: "full-index",
          startedAt: Date.now(),
          filesTotal: 0,
          filesProcessed: 0,
          phase: msg,
        });
        logger.info(msg, { tool: "codebase_index", projectPath: resolved });
      };

      // Infrastructure setup is synchronous — we need Docker/Ollama running before indexing
      let infraMessages: string[];
      try {
        infraMessages = await ensureInfrastructure(resolved, infraProgress);
      } catch (error) {
        // Clear the progress on infra failure
        setIndexingProgress(resolved, null);
        const msg = error instanceof Error ? error.message : String(error);
        return `Infrastructure setup failed:\n\n${msg}\n\nRun codebase_health for a full diagnostic.`;
      }

      // Fire-and-forget: start indexing in the background
      const bgOnProgress = (msg: string) => {
        logger.info(msg, { tool: "codebase_index", projectPath: resolved });
      };
      const extraExts = mergeExtraExtensions(args.extraExtensions as string | undefined);

      // Clear infra progress — indexProject will set its own progress
      setIndexingProgress(resolved, null);

      // Start indexing — do NOT await. Runs in the background on the event loop.
      indexProject(resolved, bgOnProgress, extraExts.size > 0 ? extraExts : undefined)
        .then(async (result) => {
          logger.info("Background indexing completed", {
            projectPath: resolved,
            filesIndexed: result.filesIndexed,
            chunksCreated: result.chunksCreated,
            cancelled: result.cancelled,
          });

          // Auto-start watcher only if indexing completed (not cancelled)
          if (!result.cancelled && !isWatching(resolved)) {
            const started = await startWatchingAutomatically(resolved);
            if (started) {
              logger.info("Auto-started file watcher", { projectPath: resolved });
            }
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("Background indexing failed", { projectPath: resolved, error: message });
        });

      // Return immediately with instructions for the LLM
      const lines = [
        ...infraMessages,
        `Indexing started in the background for: ${resolved}`,
        "",
        "IMPORTANT: Indexing is now running asynchronously.",
        "Call codebase_status to check progress. Keep calling it periodically until progress reaches 100%.",
        "Once complete, you can use codebase_search to query the indexed codebase.",
      ];
      return lines.join("\n");
    }

    case "codebase_update": {
      // Concurrency guard: prevent duplicate indexing
      const resolved = path.resolve(projectPath);
      if (isIndexingInProgress(resolved)) {
        return formatIndexingInProgressMessage(resolved, "codebase_update");
      }

      // Check Docker availability before anything else (managed mode only)
      if (QDRANT_MODE === "managed" && !(await isDockerAvailable())) {
        return DOCKER_NOT_AVAILABLE_MESSAGE;
      }

      const infraMessages = await ensureInfrastructure(resolved, onProgress);
      const updateExtraExts = mergeExtraExtensions(args.extraExtensions as string | undefined);
      const result = await updateProjectIndex(projectPath, onProgress, updateExtraExts.size > 0 ? updateExtraExts : undefined);
      const lines = [
        ...infraMessages,
        `Updated project index: ${projectPath}`,
        `Added: ${result.added}`,
        `Updated: ${result.updated}`,
        `Removed: ${result.removed}`,
        `New chunks: ${result.chunksCreated}`,
        "",
        "Progress:",
        ...progressMessages,
      ];

      // Auto-start watcher after successful update (not cancelled)
      if (!result.cancelled && !isWatching(resolved)) {
        const started = await startWatchingAutomatically(resolved);
        if (started) {
          logger.info("Auto-started file watcher after update", { projectPath: resolved });
        }
      }

      return lines.join("\n");
    }

    case "codebase_remove": {
      const resolved = path.resolve(projectPath);
      // How long to wait for a SIGTERM'd cross-process to release its lock
      const SIGNAL_TIMEOUT_MS = 10_000;
      // How long to wait for a same-process batch to drain after cancellation.
      // Embedding a large batch (hundreds of chunks) via an external API can take
      // several minutes. 5 minutes is a safe upper bound; the loop exits as soon
      // as the batch finishes, so in the common case it completes in seconds.
      const DRAIN_TIMEOUT_MS = 5 * 60_000;

      /**
       * Poll until isProjectLocked returns false or the timeout elapses.
       * Used after sending SIGTERM so we wait for the other process to exit
       * and release the lock before proceeding with the destructive delete.
       */
      async function waitForLockRelease(operation: string): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < SIGNAL_TIMEOUT_MS) {
          if (!(await isProjectLocked(resolved, operation))) return;
          await new Promise((r) => setTimeout(r, 200));
        }
        logger.warn("Lock was not released within timeout after SIGTERM, proceeding with remove", {
          projectPath: resolved,
          operation,
        });
      }

      // 1a. Stop same-process watcher
      if (isWatching(resolved)) {
        await stopWatching(resolved);
        logger.info("Stopped watcher before removing index", { projectPath: resolved });
      }

      // 1b. Terminate watcher in another process (cross-process)
      if (await isProjectLocked(resolved, "watch")) {
        const { terminated, pid } = await terminateLockHolder(resolved, "watch");
        if (terminated) {
          logger.info("Sent SIGTERM to cross-process watcher before remove", { pid, projectPath: resolved });
          await waitForLockRelease("watch");
        }
      }

      // 2a. Cancel same-process indexing and drain.
      // Track whether indexing was in-flight in THIS process so we do not
      // fall through to the cross-process path below (getLockHolderPid
      // explicitly guards against returning our own PID, so terminateLockHolder
      // can never send ourselves a signal).
      const wasIndexingInThisProcess = isIndexingInProgress(resolved);
      if (wasIndexingInThisProcess) {
        requestCancellation(resolved);
        logger.info("Requested cancellation of in-progress indexing before remove", { projectPath: resolved });
        const drainStart = Date.now();
        while (isIndexingInProgress(resolved) && Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (isIndexingInProgress(resolved)) {
          // The current batch is still running. Deleting the Qdrant collection now
          // would cause "Not Found" upsert errors as the batch finishes writing.
          // We cannot forcibly interrupt an in-process async batch — cancellation
          // fires at the next batch boundary. Refuse the remove and let the user retry.
          logger.warn("In-process indexing did not drain within 5 min timeout, refusing remove to prevent data corruption", { projectPath: resolved });
          return [
            `⚠ Cannot remove index for ${projectPath}: indexing is still running.`,
            "",
            "Cancellation has been requested. The current embedding batch will finish shortly.",
            "Please wait a moment and try codebase_remove again, or call codebase_stop first.",
          ].join("\n");
        }
      }

      // 2b. Terminate indexing in another process (cross-process only — skip if we
      // already handled it in-process, because terminateLockHolder cannot signal our
      // own PID and would otherwise log a misleading "failed to terminate" warning).
      if (!wasIndexingInThisProcess && (await isProjectLocked(resolved, "index"))) {
        const { terminated, pid } = await terminateLockHolder(resolved, "index");
        if (terminated) {
          logger.info("Sent SIGTERM to cross-process indexing before remove", { pid, projectPath: resolved });
          await waitForLockRelease("index");
        } else {
          logger.warn("Failed to terminate cross-process indexing, proceeding with remove", { projectPath: resolved });
        }
      }

      // 3. Wait for any in-flight graph build to finish
      if (isGraphBuildInProgress(resolved)) {
        logger.info("Waiting for in-flight graph build to finish before remove", { projectPath: resolved });
        await awaitGraphBuild(resolved);
      }

      await removeProjectIndex(projectPath);
      return `Removed index for: ${projectPath}`;
    }

    case "codebase_prune": {
      if (args.apply !== true) return formatPruneInventory();
      const identity = args.identity;
      const confirmationToken = args.confirmationToken;
      if (typeof identity !== "string" || typeof confirmationToken !== "string") {
        return "Prune apply requires the exact identity and confirmationToken returned by codebase_prune.";
      }
      if (args.acknowledgeNoRemoteWriters !== true) {
        return [
          `Refusing to delete ${identity}: acknowledgeNoRemoteWriters is not true.`,
          "Locks on this host cannot see an indexer on another host sharing this Qdrant. Confirm that no other host is writing to this identity, then pass acknowledgeNoRemoteWriters: true.",
        ].join("\n");
      }

      const preview = await findPruneEntry(identity);
      if (!preview) return `No resources remain for identity ${identity}. Nothing to delete.`;
      const previewRefusal = pruneRefusal(preview, identity, confirmationToken);
      if (previewRefusal) return previewRefusal;

      let activity: string | null;
      try {
        activity = await reclamationActivity(identity, preview.projectPath, true);
      } catch (err) {
        return `Refusing to delete ${identity}: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (activity) return `Refusing to delete ${identity}: ${activity}.`;

      const barrier = await acquireReclamationBarrier(identity);
      if (!barrier) return `Refusing to delete ${identity}: a writer holds one of its locks, or the reclamation barrier could not be taken.`;

      try {
        // Everything is judged again under the barrier: a writer that started
        // after the checks above, or a record that changed, is caught here.
        const entry = await findPruneEntry(identity);
        if (!entry) return `No resources remain for identity ${identity}. Nothing to delete.`;
        const refusal = pruneRefusal(entry, identity, confirmationToken);
        if (refusal) return refusal;
        const lateActivity = await reclamationActivity(identity, entry.projectPath, false);
        if (lateActivity) return `Refusing to delete ${identity}: ${lateActivity}.`;
        if (barrier.isCompromised()) return `Refusing to delete ${identity}: its reclamation barrier was lost to another process.`;

        const outcomes = await removeProjectReclamationEntry(entry);
        invalidateGraphCacheForIdentity(identity);
        if (entry.projectPath) invalidateGraphCache(entry.projectPath);
        invalidateProjectHashesForIdentity(identity);
        dropSymbolGraphCache(identity);
        resetSymbolGraphCollectionCache();

        const remaining = await findPruneEntry(identity);
        const leftover = remaining
          ? [
              ...remaining.resourceCollections.map((resource) => `collection ${resource}`),
              ...remaining.metadataRecords.map((record) => `metadata ${record.collectionName} [point ${record.pointId}]`),
            ]
          : [];
        const lines = outcomes.map((outcome) => `  ${outcome.outcome}: ${outcome.kind} ${outcome.resource}${outcome.error ? ` (${outcome.error})` : ""}`);
        if (outcomes.some((outcome) => outcome.outcome === "failed") || leftover.length > 0) {
          return [
            `Cleanup for ${identity} is incomplete.`,
            ...lines,
            ...(leftover.length > 0 ? ["Still stored after deletion:", ...leftover.map((item) => `  ${item}`)] : []),
            "Inspect the inventory before retrying; a repeated apply with a fresh token is safe.",
          ].join("\n");
        }
        return [`Removed all inventoried resources for identity: ${identity}`, ...lines].join("\n");
      } finally {
        await barrier.release();
      }
    }

    case "codebase_stop": {
      const resolved = path.resolve(projectPath);

      // Case 1: This process is indexing — cancel in-memory
      if (isIndexingInProgress(resolved)) {
        const requested = requestCancellation(resolved);
        if (!requested) {
          return `No indexing operation is currently running for: ${resolved}`;
        }
        const progress = getIndexingProgress(resolved);
        const phase = progress?.phase ?? "unknown";
        const batches = progress?.batchesProcessed ?? 0;
        const totalBatches = progress?.batchesTotal ?? "?";
        return [
          `Cancellation requested for: ${resolved}`,
          `Current phase: ${phase} (batch ${batches}/${totalBatches})`,
          "",
          "The indexing operation will stop after the current batch finishes and checkpoints.",
          "All progress up to that point is preserved — re-run codebase_index to resume.",
        ].join("\n");
      }

      // Case 2: Another process (orphan) holds the lock — try to SIGTERM it
      if (await isProjectLocked(resolved, "index")) {
        const { terminated, pid } = await terminateLockHolder(resolved, "index");
        if (terminated) {
          return [
            `Sent termination signal to orphan indexing process (PID ${pid}) for: ${resolved}`,
            "",
            "The orphan process should shut down gracefully within a few seconds.",
            "All checkpointed progress is preserved — re-run codebase_index to resume.",
          ].join("\n");
        }
        if (pid !== null) {
          return [
            `Found orphan indexing process (PID ${pid}) for: ${resolved}, but failed to terminate it.`,
            "",
            `You can manually kill it: kill ${pid}`,
            "All checkpointed progress is preserved — re-run codebase_index to resume.",
          ].join("\n");
        }
      }

      return `No indexing operation is currently running for: ${resolved}`;
    }

    case "codebase_watch": {
      const action = args.action as string;
      const watcherMode = getWatcherMode();

      if (action === "start") {
        if (watcherMode === "off") {
          return [
            "File watcher disabled by SOCRATICODE_WATCHER=off.",
            "Set SOCRATICODE_WATCHER=manual or auto and restart the MCP server before starting it.",
          ].join("\n");
        }

        await ensureInfrastructure(projectPath);

        // Catch any changes made while the watcher was not running before starting it.
        const resolved = path.resolve(projectPath);
        let updateSummary = "";
        try {
          const result = await updateProjectIndex(resolved, onProgress);
          const changed = result.added + result.updated + result.removed;
          if (changed > 0) {
            updateSummary = `\nCaught up ${changed} change(s) since last session: ${result.added} added, ${result.updated} updated, ${result.removed} removed.`;
          } else {
            updateSummary = "\nIndex is already up to date.";
          }
        } catch (err) {
          // Non-fatal — watcher still starts even if catch-up update fails
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn("codebase_watch: catch-up update failed (non-fatal)", { projectPath: resolved, error: msg });
          updateSummary = `\nWarning: could not run catch-up update (${msg}). Watcher started anyway.`;
        }

        if (!isWatching(resolved)) {
          const started = await startWatching(resolved);
          if (!started) {
            // Check if another process holds the watch lock
            if (await isProjectLocked(resolved, "watch")) {
              return `Already watched by another process: ${projectPath}${updateSummary}`;
            }
            return `Failed to start watching: ${projectPath}${updateSummary}`;
          }
        }
        return `Started watching: ${projectPath}${updateSummary}`;
      }

      if (action === "stop") {
        await stopWatching(projectPath);
        return `Stopped watching: ${projectPath}`;
      }

      // status
      const watched = getWatchedProjects();
      const resolved = path.resolve(projectPath);
      // Check if the current project is watched by another process (cross-process lock)
      const watchedByOtherProcess = !watched.includes(resolved) && await isProjectLocked(resolved, "watch");

      if (watcherMode === "off") {
        const lines = ["File watcher: disabled (SOCRATICODE_WATCHER=off)"];
        if (watched.includes(resolved)) {
          lines.push(
            "Warning: this process still has an active watcher. Restart the MCP server to apply the changed environment setting.",
          );
        } else if (watchedByOtherProcess) {
          lines.push(
            "Warning: another MCP process is still watching this project. Set SOCRATICODE_WATCHER=off for every process that uses this checkout.",
          );
        }
        return lines.join("\n");
      }

      if (watched.length === 0 && !watchedByOtherProcess) {
        if (watcherMode === "manual") {
          return [
            "No projects are currently being watched.",
            "Automatic watcher startup is disabled by SOCRATICODE_WATCHER=manual; use codebase_watch with action=start to start it explicitly.",
          ].join("\n");
        }
        return "No projects are currently being watched.";
      }
      const statusItems = watched.map((p) => `  - ${p}`);
      if (watchedByOtherProcess) {
        statusItems.push(`  - ${resolved} (watched by another process)`);
      }
      const modeLine = watcherMode === "manual" ? "\nWatcher mode: manual (started explicitly)" : "";
      return `Currently watching:\n${statusItems.join("\n")}${modeLine}`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}
