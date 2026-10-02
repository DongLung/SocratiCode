// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectIdFromPath } from "../../src/config.js";
import { assertLocalIndexRetired, automaticCleanupEnabled, captureLocalIndexOwnership, parseLocalIndexOwnership } from "../../src/services/local-index-ownership.js";
import { createGitFixture, git } from "../helpers/git.js";

vi.mock("../../src/constants.js", async (original) => ({
  ...await original<Record<string, unknown>>(), QDRANT_MODE: "managed", QDRANT_URL: undefined, QDRANT_HOST: "localhost",
}));

describe("local index retirement through real Git and filesystem boundaries", () => {
  let fixture: ReturnType<typeof createGitFixture>;
  beforeEach(() => {
    fixture = createGitFixture();
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", "local");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    vi.spyOn(os, "homedir").mockReturnValue(path.join(fixture.root, ".owner-home"));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fixture.cleanup(); });

  async function branchOwnership(branch = "topic") {
    git(fixture.root, "checkout", "-b", branch);
    return captureLocalIndexOwnership(fixture.root, projectIdFromPath(fixture.root));
  }

  async function worktreeOwnership() {
    const checkout = path.join(fixture.root, "worktrees", "topic");
    fs.mkdirSync(path.dirname(checkout));
    git(fixture.root, "worktree", "add", "-b", "topic", checkout);
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
    return { checkout, ownership: await captureLocalIndexOwnership(checkout, projectIdFromPath(checkout)) };
  }

  it("is disabled by default and does not create ownership state", async () => {
    vi.stubEnv("SOCRATICODE_AUTO_CLEANUP", undefined);
    expect(automaticCleanupEnabled()).toBe(false);
    await expect(captureLocalIndexOwnership(fixture.root, projectIdFromPath(fixture.root))).rejects.toThrow("disabled");
    expect(fs.existsSync(path.join(fixture.root, ".owner-home"))).toBe(false);
  });

  it("retains a branch after switching, merging or squash merging, then proves deletion", async () => {
    const ownership = await branchOwnership();
    fs.writeFileSync(path.join(fixture.root, "main.ts"), "export const changed = true;\n");
    git(fixture.root, "commit", "-am", "Branch fixture");
    git(fixture.root, "checkout", "main");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("still registered");
    git(fixture.root, "merge", "--squash", "topic");
    git(fixture.root, "commit", "-m", "Squash fixture");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("still registered");
    git(fixture.root, "merge", "topic", "--no-edit");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("still registered");
    git(fixture.root, "branch", "-D", "topic");
    await expect(assertLocalIndexRetired(ownership)).resolves.toBeUndefined();
    expect(git(fixture.root, "branch", "--list", "main")).toBe("* main");
  });

  it("does not infer branch retirement from a deleted ref still used by a registered worktree", async () => {
    const ownership = await branchOwnership();
    git(fixture.root, "update-ref", "-d", "refs/heads/topic");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("still uses");
  });

  it("requires worktree unregistration, not just a missing directory", async () => {
    const { checkout, ownership } = await worktreeOwnership();
    fs.rmSync(checkout, { recursive: true });
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow();
    git(fixture.root, "worktree", "prune", "--expire", "now");
    await expect(assertLocalIndexRetired(ownership)).resolves.toBeUndefined();
    expect(git(fixture.root, "branch", "--list", "topic")).toContain("topic");
  });

  it("proves worktree removal but retains a recreated source directory", async () => {
    const { checkout, ownership } = await worktreeOwnership();
    git(fixture.root, "worktree", "remove", checkout);
    await expect(assertLocalIndexRetired(ownership)).resolves.toBeUndefined();
    fs.mkdirSync(checkout);
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("still exists");
  });

  it("retains a moved worktree whose Git registration is still active at another path", async () => {
    const { checkout, ownership } = await worktreeOwnership();
    git(fixture.root, "worktree", "move", checkout, `${checkout}-moved`);
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow();
  });

  it("refuses unavailable/replaced repository or parent directories and permission errors", async () => {
    const { checkout, ownership } = await worktreeOwnership();
    git(fixture.root, "worktree", "remove", checkout);
    const realpath = fsp.realpath;
    const denied = Object.assign(new Error("synthetic permission denied"), { code: "EACCES" });
    vi.spyOn(fsp, "realpath").mockImplementation(async (candidate) => {
      if (candidate === ownership.checkoutParent.path) throw denied;
      return realpath(candidate);
    });
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("permission denied");
    vi.restoreAllMocks();
    vi.spyOn(os, "homedir").mockReturnValue(path.join(fixture.root, ".owner-home"));
    fs.renameSync(ownership.checkoutParent.path, `${ownership.checkoutParent.path}-retired`);
    fs.mkdirSync(ownership.checkoutParent.path);
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("filesystem directory changed");
    fs.renameSync(path.join(fixture.root, ".git"), path.join(fixture.root, ".git-unavailable"));
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow();
  });

  it("preserves primary non-branch, pinned and malformed configuration identities", async () => {
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "false");
    await expect(captureLocalIndexOwnership(fixture.root, projectIdFromPath(fixture.root))).rejects.toThrow("primary non-branch");
    vi.stubEnv("SOCRATICODE_BRANCH_AWARE", "true");
    const ownership = await branchOwnership();
    git(fixture.root, "checkout", "main");
    git(fixture.root, "branch", "-D", "topic");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "shared");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("pinned/shared");
    vi.stubEnv("SOCRATICODE_PROJECT_ID", "");
    fs.writeFileSync(path.join(fixture.root, ".socraticode.json"), JSON.stringify({ projectId: ownership.identity }));
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("pinned/shared");
    fs.writeFileSync(path.join(fixture.root, ".socraticode.json"), "{");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow();
  });

  it("retains branch-name collisions, foreign ownership and missing ownership state", async () => {
    const ownership = await branchOwnership("topic/one");
    git(fixture.root, "checkout", "main");
    git(fixture.root, "branch", "-D", "topic/one");
    git(fixture.root, "branch", "topic_one");
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("different branch refs");
    git(fixture.root, "branch", "-D", "topic_one");
    await expect(assertLocalIndexRetired({ ...ownership, ownerId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow("another local installation");
    fs.rmSync(path.join(fixture.root, ".owner-home", ".socraticode", "local-index-owner"));
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow();
    expect(parseLocalIndexOwnership({ ...ownership, version: 2 })).toBeNull();
    expect(parseLocalIndexOwnership(undefined)).toBeNull();
  });

  it("reports an unavailable Git executable instead of authorizing deletion", async () => {
    const ownership = await branchOwnership();
    git(fixture.root, "checkout", "main");
    git(fixture.root, "branch", "-D", "topic");
    vi.stubEnv("PATH", fixture.root);
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("Git retirement evidence unavailable");
  });

  it.skipIf(process.platform === "win32")("terminates a hung Git executable without authorizing deletion", async () => {
    const ownership = await branchOwnership();
    git(fixture.root, "checkout", "main");
    git(fixture.root, "branch", "-D", "topic");
    const bin = path.join(fixture.root, "timeout-bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
    vi.stubEnv("PATH", bin);
    await expect(assertLocalIndexRetired(ownership)).rejects.toThrow("Git did not respond within 5 seconds");
  }, 10_000);
});
