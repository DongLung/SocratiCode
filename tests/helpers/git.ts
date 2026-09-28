// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Run fixture Git commands with synthetic author details, signing off, and no hooks. */
export function git(projectPath: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "user.name=Git refresh test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${path.join(projectPath, ".empty-hooks")}`,
    ...args,
  ], { cwd: projectPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Create a disposable committed checkout and return cleanup for that checkout only. */
export function createGitFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-git-refresh-")));
  git(root, "init", "-b", "main");
  fs.writeFileSync(path.join(root, "main.ts"), "export function greeting() { return 'initial'; }\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Initial fixture");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
