// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildCodeGraph,
  ensureDynamicLanguages,
  invalidateGraphCache,
} from "../../src/services/code-graph.js";
import { addFileToFixture, createFixtureProject, type FixtureProject } from "../helpers/fixtures.js";

describe("buildCodeGraph node language", () => {
  let fixture: FixtureProject;

  beforeAll(() => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "1"); // deterministic: content detection on
    ensureDynamicLanguages();
    fixture = createFixtureProject("node-language");
    addFileToFixture(fixture.root, "scripts/deploy", "#!/bin/bash\necho deploying\n");
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
});
