// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import { gitProjectId, gitRefreshTarget, readGitState, sameGitState } from "../../src/services/git-state.js";
import { createGitFixture, git } from "../helpers/git.js";

describe("Git refresh observations through the Git executable", () => {
  let fixture: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    fixture = createGitFixture();
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
  });
  afterEach(() => { vi.unstubAllEnvs(); fixture.cleanup(); });

  it("distinguishes commits, same-commit branch switches, detached HEAD, and branch identities", async () => {
    const first = await readGitState(fixture.root);
    expect(first).toEqual({ ref: "refs/heads/main", head: git(fixture.root, "rev-parse", "HEAD") });
    expect(gitProjectId(fixture.root, first)).toBe(projectIdFromPath(fixture.root));
    git(fixture.root, "checkout", "-b", "feature");
    const branch = await readGitState(fixture.root);
    expect(branch.head).toBe(first.head);
    expect(sameGitState(first, branch)).toBe(false);
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    expect(gitProjectId(fixture.root, branch)).toBe(projectIdFromPath(fixture.root));
    expect(gitProjectId(fixture.root, branch)).not.toBe(gitProjectId(fixture.root, first));
    const captured = gitRefreshTarget(fixture.root, branch, true);
    git(fixture.root, "checkout", "--detach");
    const detached = await readGitState(fixture.root);
    expect(detached).toEqual({ ref: null, head: first.head });
    expect(gitProjectId(fixture.root, detached)).toBe(projectIdFromPath(fixture.root));
    await expect(captured.assertCurrent()).rejects.toThrow("checkout changed");
    expect(captured.projectId).toBe(gitProjectId(fixture.root, branch));
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "git-refresh-test-shared");
    expect(gitProjectId(fixture.root, branch)).toBe(gitProjectId(fixture.root, detached));
  });

  it("observes fast-forwards and rebases but not file saves or fetches", async () => {
    const first = await readGitState(fixture.root);
    fs.writeFileSync(path.join(fixture.root, "main.ts"), "export const changed = true;\n");
    expect(await readGitState(fixture.root)).toEqual(first);
    git(fixture.root, "checkout", "-b", "upstream");
    git(fixture.root, "commit", "-am", "Upstream fixture");
    const upstream = await readGitState(fixture.root);
    git(fixture.root, "checkout", "main");
    git(fixture.root, "fetch", ".", "upstream:refs/remotes/fixture/upstream");
    expect(await readGitState(fixture.root)).toEqual(first);
    git(fixture.root, "merge", "--ff-only", "upstream");
    expect(await readGitState(fixture.root)).toEqual({ ref: first.ref, head: upstream.head });
    git(fixture.root, "checkout", "-b", "topic", first.head);
    fs.writeFileSync(path.join(fixture.root, "topic.ts"), "export const topic = true;\n");
    git(fixture.root, "add", ".");
    git(fixture.root, "commit", "-m", "Topic fixture");
    const beforeRebase = await readGitState(fixture.root);
    git(fixture.root, "rebase", "main");
    const afterRebase = await readGitState(fixture.root);
    expect(afterRebase.ref).toBe(beforeRebase.ref);
    expect(afterRebase.head).not.toBe(beforeRebase.head);
  });

  it("reports non-Git directories and a missing executable without inventing state", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-not-git-"));
    try {
      await expect(readGitState(empty)).rejects.toThrow("not a git repository");
      vi.stubEnv("PATH", empty);
      await expect(readGitState(fixture.root)).rejects.toThrow("could not be found");
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("terminates a hung executable and reports the real timeout boundary", async () => {
    const bin = path.join(fixture.root, "timeout-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    await expect(readGitState(fixture.root)).rejects.toThrow("did not respond within 5 seconds");
  }, 10_000);
});
