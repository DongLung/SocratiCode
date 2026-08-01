// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPhpPsr4Map, resolveImport } from "../../src/services/graph-resolution.js";

/**
 * PHP namespaces carry no path information, so `composer.json` is the only
 * authority on where one lives. Before the PSR-4 map, resolution guessed from
 * the directory layout: it handled `App\` → `app/` and missed everything else,
 * which in a Composer monorepo is every cross-package import.
 */
describe("PHP PSR-4 resolution", () => {
  let root: string;
  const fileSet = new Set<string>();

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "psr4-"));

    // Host app: the conventional layout, plus a lowercase directory whose
    // namespace segment is capitalised (`Database\Seeders\` → `database/seeders`).
    write("composer.json", JSON.stringify({
      autoload: {
        "psr-4": {
          "App\\": "app/",
          "Database\\Seeders\\": "database/seeders/",
        },
      },
      "autoload-dev": { "psr-4": { "Tests\\": "tests/" } },
    }));

    // An in-repo package, consumed via a Composer path repository.
    write("packages/auth/composer.json", JSON.stringify({
      autoload: {
        "psr-4": {
          "Acme\\Auth\\": "src/",
          "Acme\\Auth\\Database\\Seeders\\": "database/seeders/",
        },
      },
    }));

    // A vendor copy that must never win: path repositories symlink
    // vendor/<pkg> back to the source, so indexing it would duplicate files.
    write("vendor/acme/auth/composer.json", JSON.stringify({
      autoload: { "psr-4": { "Acme\\Auth\\": "src/" } },
    }));

    for (const rel of [
      "app/Http/Controllers/BaseController.php",
      "database/seeders/DatabaseSeeder.php",
      "tests/TestCase.php",
      "packages/auth/src/Models/Role.php",
      "packages/auth/database/seeders/AuthSeeder.php",
    ]) {
      write(rel, "<?php\n");
      fileSet.add(rel);
    }
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const resolve = (spec: string): string | null =>
    resolveImport(
      spec, path.join(root, "app/Http/Controllers/Caller.php"), root,
      fileSet, "php", undefined, undefined, undefined, undefined,
      buildPhpPsr4Map(root),
    );

  it("collects prefixes from the root manifest and every in-repo package", () => {
    const map = buildPhpPsr4Map(root);
    expect(map.get("App\\")).toEqual(["app"]);
    expect(map.get("Acme\\Auth\\")).toEqual(["packages/auth/src"]);
    // autoload-dev counts too — test suites import each other.
    expect(map.get("Tests\\")).toEqual(["tests"]);
  });

  it("skips vendor manifests so a symlinked path repo cannot duplicate a package", () => {
    expect(buildPhpPsr4Map(root).get("Acme\\Auth\\")).not.toContain("vendor/acme/auth/src");
  });

  it("honours .socraticodeignore so an excluded package contributes no prefixes", () => {
    // A directory the project excluded from indexing has no indexed files, so
    // prefixes pointing into it could only ever resolve to nothing.
    const ignored = mkdtempSync(path.join(tmpdir(), "psr4-ignored-"));
    try {
      mkdirSync(path.join(ignored, "packages/legacy"), { recursive: true });
      writeFileSync(path.join(ignored, "composer.json"), JSON.stringify({
        autoload: { "psr-4": { "App\\": "app/" } },
      }));
      writeFileSync(path.join(ignored, "packages/legacy/composer.json"), JSON.stringify({
        autoload: { "psr-4": { "Legacy\\": "src/" } },
      }));
      writeFileSync(path.join(ignored, ".socraticodeignore"), "packages/legacy/\n");

      const map = buildPhpPsr4Map(ignored);
      expect(map.get("App\\")).toEqual(["app"]);
      expect(map.has("Legacy\\")).toBe(false);
    } finally {
      rmSync(ignored, { recursive: true, force: true });
    }
  });

  it("resolves a cross-package import that no directory-shaped guess can reach", () => {
    expect(resolve("Acme\\Auth\\Models\\Role")).toBe("packages/auth/src/Models/Role.php");
  });

  it("prefers the longest matching prefix", () => {
    // `Acme\Auth\` also prefixes this; picking it would look under
    // packages/auth/src/Database/Seeders and find nothing.
    expect(resolve("Acme\\Auth\\Database\\Seeders\\AuthSeeder"))
      .toBe("packages/auth/database/seeders/AuthSeeder.php");
  });

  it("resolves a prefix whose directory case differs from the namespace", () => {
    // The old lowercase-first-segment guess produced `database/Seeders/…`.
    expect(resolve("Database\\Seeders\\DatabaseSeeder")).toBe("database/seeders/DatabaseSeeder.php");
  });

  it("still resolves the conventional layout", () => {
    expect(resolve("App\\Http\\Controllers\\BaseController"))
      .toBe("app/Http/Controllers/BaseController.php");
  });

  it("returns null for a namespace no manifest declares", () => {
    expect(resolve("Nope\\Missing\\Thing")).toBeNull();
  });

  it("is a no-op when the project has no composer.json", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "psr4-empty-"));
    try {
      expect(buildPhpPsr4Map(empty).size).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
