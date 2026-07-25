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
});
