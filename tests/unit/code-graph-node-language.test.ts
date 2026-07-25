// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCodeGraph,
  ensureDynamicLanguages,
  invalidateGraphCache,
} from "../../src/services/code-graph.js";
import {
  addFileToFixture,
  createFixtureProject,
  type FixtureProject,
  freshProgress,
  oversizedPy,
} from "../helpers/fixtures.js";

describe("buildCodeGraph node language", () => {
  let fixture: FixtureProject;

  beforeAll(() => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "1"); // deterministic: content detection on
    ensureDynamicLanguages();
    // Every fixture here is shared by all tests below, some of which assert an
    // exact `progress.filesSkipped`. Adding a file that skips breaks those, not
    // just your own — oversized, unreadable, or extensionless content that
    // detects a grammar on the 8 KB head but not on the full read.
    fixture = createFixtureProject("node-language");
    addFileToFixture(fixture.root, "scripts/deploy", "#!/bin/bash\necho deploying\n");

    // An oversized (>1 MB) extensionless Python script that another module
    // imports. It is admitted by discovery (which reads only the 8 KB head),
    // then skipped at the size guard — so its only node is the placeholder its
    // importer creates, which must still carry the detected language.
    // Two pairs cover both processing orders under the sorted walk:
    // aaa_import.py runs before zzz_target (importer first), and aaa_target
    // runs before zzz_import.py (target first).
    addFileToFixture(fixture.root, "aaa_import.py", "import zzz_target\n");
    addFileToFixture(fixture.root, "zzz_target", oversizedPy());
    addFileToFixture(fixture.root, "aaa_target", oversizedPy());
    addFileToFixture(fixture.root, "zzz_import.py", "import aaa_target\n");

    // Fixture pair for the shell source-directive edge. The unit tests in
    // graph-resolution.test.ts call resolveImport directly, so only a full
    // buildCodeGraph run pins the language label that reaches it.
    addFileToFixture(fixture.root, "a.sh", "source ./b.sh\n");
    addFileToFixture(fixture.root, "b.sh", "#!/bin/bash\necho hi\n");

    // Literal resolution is the only path shell has, so an extensionless target
    // must match on its own relative path. This pair carries its own target so
    // neither test's target picks up a dependent belonging to the other.
    addFileToFixture(fixture.root, "scripts/setup", "#!/bin/bash\necho setting up\n");
    addFileToFixture(fixture.root, "scripts/run.sh", "source ./setup\n");

    // Stylus is graphed through the CSS grammar, so a .styl file is parsed and
    // its @require edges resolve; the node carries the Stylus label. Both are
    // small and grammar-bearing, so neither adds to `progress.filesSkipped`.
    // The @require deliberately omits the extension: resolveRelativePath tries a
    // direct fileSet match first, so spelling it "./base.styl" would resolve on
    // that and never reach the extension-append loop that consults `.styl`.
    addFileToFixture(fixture.root, "theme.styl", '@require "./base"\n');
    addFileToFixture(fixture.root, "base.styl", ".btn { color: red; }\n");
  });

  afterAll(() => {
    invalidateGraphCache(fixture.root);
    fixture.cleanup();
    vi.unstubAllEnvs();
  });

  it("stores the detected language on a grammar-bearing extensionless node", async () => {
    const graph = await buildCodeGraph(fixture.root);
    const deploy = graph.nodes.find((n) => n.relativePath === "scripts/deploy");
    expect(deploy).toBeDefined();
    expect(deploy?.language).toBe("shell");
  });

  it("stores the language on ordinary extensioned nodes too", async () => {
    const graph = await buildCodeGraph(fixture.root);
    const index = graph.nodes.find((n) => n.relativePath === "src/index.ts");
    expect(index?.language).toBe("typescript");
  });

  it("labels an oversized extensionless import target by detected language (importer first)", async () => {
    const progress = freshProgress();
    const graph = await buildCodeGraph(fixture.root, undefined, progress);
    const target = graph.nodes.find((n) => n.relativePath === "zzz_target");
    expect(target).toBeDefined();
    expect(target?.language).toBe("python");
    // Both padded fixtures must actually exceed MAX_GRAPH_FILE_BYTES, or this and
    // the test below stop exercising the placeholder branch: a processed file gets
    // its own node and is labelled python by a different code path.
    expect(progress.filesSkipped).toBe(2);
  });

  it("labels an oversized extensionless import target by detected language (target first)", async () => {
    const progress = freshProgress();
    const graph = await buildCodeGraph(fixture.root, undefined, progress);
    const target = graph.nodes.find((n) => n.relativePath === "aaa_target");
    expect(target).toBeDefined();
    expect(target?.language).toBe("python");
    expect(progress.filesSkipped).toBe(2);
  });

  it("resolves a shell source directive to a graph edge", async () => {
    const graph = await buildCodeGraph(fixture.root);
    expect(graph.edges.some((e) => e.source === "a.sh" && e.target === "b.sh")).toBe(true);
  });

  it("resolves a shell source directive naming an extensionless target", async () => {
    const graph = await buildCodeGraph(fixture.root);
    expect(
      graph.edges.some((e) => e.source === "scripts/run.sh" && e.target === "scripts/setup"),
    ).toBe(true);
  });

  it("labels .styl nodes stylus", async () => {
    const graph = await buildCodeGraph(fixture.root);
    expect(graph.nodes.find((n) => n.relativePath === "theme.styl")?.language).toBe("stylus");
    expect(graph.nodes.find((n) => n.relativePath === "base.styl")?.language).toBe("stylus");
  });

  it("resolves @require edges between .styl files", async () => {
    const graph = await buildCodeGraph(fixture.root);
    expect(graph.edges.some((e) => e.source === "theme.styl" && e.target === "base.styl")).toBe(true);
  });
});
