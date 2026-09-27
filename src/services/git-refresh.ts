// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import path from "node:path";
import { collectionName } from "../config.js";
import { getWatcherMode } from "../constants.js";
import { invalidateGraphCache } from "./code-graph.js";
import { type GitState, gitProjectId, gitRefreshTarget, readGitState, sameGitState } from "./git-state.js";
import { isIndexingInProgress, updateProjectIndex } from "./indexer.js";
import { logger } from "./logger.js";
import { getCollectionInfo } from "./qdrant.js";
import { dropSymbolGraphCache } from "./symbol-graph-cache.js";

const POLL_MS = 10_000;

interface Project {
  path: string;
  registered: boolean;
  stopped: boolean;
  observed?: GitState;
  synchronized?: GitState;
  projectId?: string;
  pending: boolean;
  allowCreate: boolean;
  revision: number;
  observationError?: string;
  refreshError?: string;
  retryAt: number;
  checking?: Promise<void>;
  running?: Promise<void>;
  timer?: NodeJS.Timeout;
  extraExtensions?: Set<string>;
}

const projects = new Map<string, Project>();

function project(projectPath: string): Project {
  const resolved = path.resolve(projectPath);
  let entry = projects.get(resolved);
  if (!entry) {
    entry = { path: resolved, registered: false, stopped: false, pending: false, allowCreate: false, revision: 0, retryAt: 0 };
    projects.set(resolved, entry);
  }
  return entry;
}

function schedule(entry: Project): void {
  if (entry.stopped || !entry.registered || entry.timer) return;
  if (getWatcherMode() !== "git") { stopGitRefresh(entry.path); return; }
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void checkGitRefresh(entry.path).then(() => schedule(entry));
  }, POLL_MS);
  entry.timer.unref();
}

function isCurrent(entry: Project): boolean {
  return !entry.pending && !entry.running && !entry.observationError && !entry.refreshError
    && sameGitState(entry.synchronized, entry.observed);
}

function observe(entry: Project, state: GitState): void {
  const identity = gitProjectId(entry.path, state);
  if (entry.observed && (!sameGitState(entry.observed, state) || entry.projectId !== identity)) {
    // Preserve a new branch's pending first index across further commits, but
    // do not transfer that permission to a newly configured explicit identity.
    entry.allowCreate = entry.registered && (entry.projectId === identity
      ? entry.allowCreate
      : gitProjectId(entry.path, entry.observed) !== identity);
    entry.pending = true;
    entry.revision++;
    entry.retryAt = 0;
    invalidateGraphCache(entry.path);
    dropSymbolGraphCache(identity);
  }
  entry.observed = state;
  entry.projectId = identity;
  entry.observationError = undefined;
}

async function refresh(entry: Project): Promise<void> {
  const state = entry.observed;
  if (!state || !entry.projectId || entry.stopped) return;
  const revision = entry.revision;
  const target = gitRefreshTarget(entry.path, state, entry.allowCreate);
  const assertGitCurrent = target.assertCurrent;
  target.assertCurrent = async () => {
    if (entry.stopped) throw new Error("Git refresh stopped.");
    if (entry.revision !== revision) throw new Error("Git checkout changed during indexing; refresh remains pending.");
    await assertGitCurrent();
  };
  try {
    // Selecting git mode never creates an index. Only an observed transition
    // to a different branch-aware identity may create its first collection.
    const canRefresh = target.allowCreate || await getCollectionInfo(collectionName(target.projectId));
    await target.assertCurrent();
    if (!canRefresh) {
      entry.registered = false;
      entry.pending = false;
      entry.synchronized = undefined;
      return;
    }
    const result = await updateProjectIndex(entry.path, undefined, entry.extraExtensions, target);
    if (result.skipped) throw new Error(result.skipped);
    if (result.cancelled) throw new Error("Index update was cancelled; Git refresh remains pending.");
    await target.assertCurrent();
    entry.refreshError = undefined;
    if (entry.revision === revision) {
      entry.synchronized = state;
      entry.pending = false;
      entry.allowCreate = false;
      invalidateGraphCache(entry.path);
      dropSymbolGraphCache(target.projectId);
    }
  } catch (err) {
    entry.pending = true;
    entry.refreshError = err instanceof Error ? err.message : String(err);
    entry.retryAt = Date.now() + POLL_MS;
    logger.warn("Git refresh remains pending", { projectPath: entry.path, error: entry.refreshError });
  }
}

/** Observe without waiting for indexing. Tools can report pending results. */
export async function checkGitRefresh(projectPath: string, catchUp = false): Promise<void> {
  if (getWatcherMode() !== "git") return;
  const entry = project(projectPath);
  if (entry.checking) {
    await entry.checking;
    if (catchUp) return checkGitRefresh(projectPath, true);
    return;
  }
  entry.checking = (async () => {
    try {
      const state = await readGitState(entry.path);
      if (entry.stopped) return;
      observe(entry, state);
      if (!entry.registered) {
        if (!await getCollectionInfo(collectionName(entry.projectId as string))) return;
        if (entry.stopped) return;
        entry.registered = true;
        entry.pending = catchUp || process.env.SOCRATICODE_AUTO_RESUME?.trim().toLowerCase() !== "off";
      } else if (catchUp) {
        entry.pending = true;
      }
      schedule(entry);
      if (entry.pending && !entry.running && !isIndexingInProgress(entry.path) && Date.now() >= entry.retryAt) {
        entry.running = refresh(entry).finally(() => { entry.running = undefined; });
      }
    } catch (err) {
      entry.observationError = err instanceof Error ? err.message : String(err);
    }
  })();
  try { await entry.checking; } finally { entry.checking = undefined; }
}

/** Startup already selected an indexed project and awaits its normal catch-up. */
export async function resumeGitRefresh(projectPath: string): Promise<void> {
  await checkGitRefresh(projectPath, true);
  await projects.get(path.resolve(projectPath))?.running;
}

/** Capture an explicit operation so its successful result can seed monitoring. */
export async function prepareGitIndex(projectPath: string, extraExtensions?: Set<string>) {
  if (getWatcherMode() !== "git") return undefined;
  const entry = project(projectPath);
  entry.extraExtensions = extraExtensions;
  try {
    const state = await readGitState(entry.path);
    observe(entry, state);
    return { state, target: gitRefreshTarget(entry.path, state, true), entry, revision: entry.revision };
  } catch (err) {
    entry.observationError = err instanceof Error ? err.message : String(err);
    logger.warn(entry.observationError, { projectPath: entry.path });
    // Explicit indexing remains available in a non-Git project. Its tool
    // response/status reports the Git error; monitoring never falls back.
    return undefined;
  }
}

export async function finishGitIndex(
  projectPath: string,
  operation: Awaited<ReturnType<typeof prepareGitIndex>>,
  result: { cancelled: boolean; skipped?: string },
): Promise<void> {
  if (getWatcherMode() !== "git" || !operation) return;
  const entry = projects.get(path.resolve(projectPath));
  if (!entry || entry !== operation.entry || entry.stopped) return;
  entry.registered = true;
  try {
    if (result.skipped) throw new Error(result.skipped);
    if (result.cancelled) throw new Error("Index update was cancelled; Git refresh remains pending.");
    await operation.target.assertCurrent();
    if (entry.revision !== operation.revision) throw new Error("Git checkout changed during indexing; refresh remains pending.");
    entry.synchronized = operation.state;
    entry.pending = false;
    entry.refreshError = undefined;
    entry.allowCreate = false;
    invalidateGraphCache(entry.path);
    dropSymbolGraphCache(operation.target.projectId);
  } catch (err) {
    entry.pending = true;
    entry.refreshError = err instanceof Error ? err.message : String(err);
    entry.retryAt = Date.now() + POLL_MS;
  }
  schedule(entry);
}

export function gitRefreshStatus(projectPath: string): string {
  const entry = projects.get(path.resolve(projectPath));
  if (!entry) return "Git refresh: not monitoring this project yet.";
  if (entry.observationError) return `Git refresh unavailable: ${entry.observationError}\nRun codebase_update explicitly; automatic file watching is disabled.`;
  if (!entry.registered) return "Git refresh: no existing index to monitor. Run codebase_index explicitly.";
  if (entry.refreshError) return `Git refresh: FAILED, pending retry. ${entry.refreshError}\nResults may be stale until a refresh succeeds.`;
  if (entry.running || entry.pending) return "Git refresh: PENDING. Results may be stale until indexing and graph reconciliation finish.";
  if (!isCurrent(entry)) return "Git refresh: monitoring; index freshness is unverified because startup catch-up is disabled. Run codebase_update explicitly.";
  return `Git refresh: synchronized with ${entry.observed?.ref ?? "detached HEAD"} at ${entry.observed?.head.slice(0, 12)}.\nWorking-tree edits without a ref/HEAD change require codebase_update.`;
}

export async function withGitRefreshNotice(projectPath: string, read: () => Promise<string>): Promise<string> {
  if (getWatcherMode() !== "git") return read();
  await checkGitRefresh(projectPath);
  const entry = project(projectPath);
  const wasCurrent = isCurrent(entry);
  const before = entry.observed;
  const result = await read();
  await checkGitRefresh(projectPath);
  const changedDuringRead = !sameGitState(before, entry.observed);
  const notice = (!wasCurrent || changedDuringRead) && isCurrent(entry)
    ? "Git refresh completed while this request was running. Repeat the request for current results."
    : gitRefreshStatus(projectPath);
  return `${notice}\n\n${result}`;
}

export function stopGitRefresh(projectPath: string): void {
  const resolved = path.resolve(projectPath);
  const entry = projects.get(resolved);
  if (!entry) return;
  entry.stopped = true;
  if (entry.timer) clearTimeout(entry.timer);
  projects.delete(resolved);
}

export function stopAllGitRefreshes(): void {
  for (const key of projects.keys()) stopGitRefresh(key);
}
