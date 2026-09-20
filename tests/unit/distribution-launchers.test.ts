// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedCommand = "npx";
const expectedArgs = ["-y", "--prefer-online", "socraticode@latest"];

function readText(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function expectLauncher(server: Record<string, unknown>, source: string): void {
  expect(server.command, `${source} command`).toBe(expectedCommand);
  expect(server.args, `${source} args`).toEqual(expectedArgs);
}

/**
 * Resolves `${VAR}` and `${VAR:-default}` the way the Claude Code host does,
 * so the shipped manifest can be asserted as the host will actually see it
 * rather than as the literal text it contains.
 */
function expand<T>(value: T, env: Record<string, string> = {}): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (whole, name: string, fallback?: string) => env[name] ?? fallback ?? whole,
    ) as unknown as T;
  }
  if (Array.isArray(value)) return value.map((entry) => expand(entry, env)) as unknown as T;
  return value;
}

/**
 * The Claude Code plugin's server definition, resolved the way the host
 * resolves it: `plugin.json` names a file, and that file holds the definition.
 *
 * The indirection is deliberate. General `${VAR:-default}` expansion is
 * documented for `.mcp.json` files; for `plugin.json` the reference documents
 * only `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and
 * `${CLAUDE_PROJECT_DIR}`, and says nothing either way about arbitrary
 * environment variables. An inline definition does expand them in practice
 * (measured on 2.1.278), but a shipped plugin should not rest on behaviour the
 * reference does not describe.
 */
function claudePluginServer(): Record<string, unknown> {
  const manifest = readJson(".claude-plugin/plugin.json");
  const declared = manifest.mcpServers;

  expect(
    typeof declared,
    "plugin.json must name a file rather than define servers inline: general " +
      "environment-variable expansion is documented for mcp.json files, and " +
      "for plugin.json only the three plugin path variables are documented",
  ).toBe("string");

  const servers = readJson(declared as string).mcpServers as Record<
    string,
    Record<string, unknown>
  >;
  return servers.socraticode;
}

describe("distributed MCP launchers", () => {
  it("uses the update-aware launcher in every bundled MCP definition", () => {
    for (const relativePath of [".mcp.json", "mcp.json", "gemini-extension.json"]) {
      const config = readJson(relativePath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expectLauncher(servers.socraticode, relativePath);
    }
  });

  it("keeps the VS Code manifest and runtime fallback aligned", () => {
    const manifest = readJson("extension/package.json");
    const contributes = manifest.contributes as Record<string, unknown>;
    const configuration = contributes.configuration as Record<string, unknown>;
    const properties = configuration.properties as Record<string, Record<string, unknown>>;

    expect(properties["socraticode.command"].default).toBe(expectedCommand);
    expect(properties["socraticode.args"].default).toEqual(expectedArgs);

    const settingsSource = readText("extension/src/settings.ts");
    expect(settingsSource).toContain(
      'c.get<string[]>("args", ["-y", "--prefer-online", "socraticode@latest"])',
    );
  });

  it("encodes the same launcher in every VS Code install link", () => {
    const readme = readText("README.md");
    const links = readme.match(
      /https:\/\/(?:insiders\.)?vscode\.dev\/redirect\/mcp\/install\?[^)"\s]+/g,
    );

    expect(links?.length).toBe(4);
    for (const link of links ?? []) {
      const config = new URL(link).searchParams.get("config");
      expect(config, link).not.toBeNull();
      expectLauncher(JSON.parse(config ?? "{}") as Record<string, unknown>, link);
    }
  });

  it("encodes the same launcher in every Cursor install link", () => {
    const readme = readText("README.md");
    const links = readme.match(
      /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^)"\s]+/g,
    );

    expect(links?.length).toBe(2);
    for (const link of links ?? []) {
      const encodedConfig = new URL(link).searchParams.get("config");
      expect(encodedConfig, link).not.toBeNull();
      const config = JSON.parse(Buffer.from(encodedConfig ?? "", "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
      expectLauncher(config, link);
    }
  });

  it("resolves the Claude Code plugin launcher to the shared default when unset", () => {
    const server = claudePluginServer();
    expect(expand(server.command as string), ".claude-plugin/plugin.json command").toBe(expectedCommand);
    expect(expand(server.args as string[]), ".claude-plugin/plugin.json args").toEqual(expectedArgs);
  });

  it("lets the Claude Code plugin specification be pinned", () => {
    const server = claudePluginServer();

    // The command stays npx: `${VAR}` expands per string, so a fixed-arity args
    // array cannot express a whole-command override — overriding the command
    // alone would leave `-y --prefer-online` in front of it and launch nothing.
    expect(expand(server.command as string, { SOCRATICODE_SPEC: "socraticode@1.0.0" })).toBe(
      expectedCommand,
    );
    expect(expand(server.args as string[], { SOCRATICODE_SPEC: "socraticode@1.0.0" })).toEqual([
      "-y",
      "--prefer-online",
      "socraticode@1.0.0",
    ]);
  });

  it("leaves the shared launcher definition untouched for Codex and Cursor", () => {
    for (const relativePath of [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]) {
      const manifest = readJson(relativePath);
      expect(manifest.mcpServers, `${relativePath} mcpServers`).toBe("./.mcp.json");
    }

    // The shared file carries no host-specific expansion syntax, which is what
    // keeps it safe for hosts whose support for it is unverified.
    for (const relativePath of [".mcp.json", "mcp.json"]) {
      expect(readText(relativePath), relativePath).not.toContain("${");
    }

    // ...and Claude Code's definition is a file of its own, so widening it
    // cannot reach the hosts that share the other one.
    const claudeManifest = readJson(".claude-plugin/plugin.json");
    expect(claudeManifest.mcpServers).not.toBe("./.mcp.json");
  });

  it("does not retain the former cached launcher in shipped guidance", () => {
    for (const relativePath of [
      "README.md",
      "DEVELOPER.md",
      "extension/README.md",
      "extension/src/mcpProvider.ts",
    ]) {
      const contents = readText(relativePath);
      expect(contents, relativePath).not.toMatch(/npx -y socraticode(?:@latest)?/);
      expect(contents, relativePath).not.toContain('["-y", "socraticode"]');
      expect(contents, relativePath).not.toContain('["npx", "-y", "socraticode"]');
    }
  });
});
