// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_GRAPH_FILE_BYTES } from "../../src/constants.js";
import { buildCodeGraph, ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { logger } from "../../src/services/logger.js";
import {
  addFileToFixture,
  canTestPermissionDenied,
  createFixtureProject,
  type FixtureProject,
  freshProgress,
  oversizedPy,
  oversizedTs,
} from "../helpers/fixtures.js";

describe("graph build skip accounting", () => {
  beforeAll(() => {
    ensureDynamicLanguages();
  });

  describe("oversized file with no importer", () => {
    let fixture: FixtureProject;
    beforeAll(() => {
      fixture = createFixtureProject("skips-oversized");
      addFileToFixture(fixture.root, "src/huge.ts", oversizedTs());
    });
    afterAll(() => fixture.cleanup());

    it("drops it from the graph but counts it as processed and skipped", async () => {
      const progress = freshProgress();
      const graph = await buildCodeGraph(fixture.root, undefined, progress);

      expect(graph.nodes.find((n) => n.relativePath === "src/huge.ts")).toBeUndefined();
      expect(progress.filesProcessed).toBe(progress.filesTotal);
      expect(progress.filesSkipped).toBe(1);
    });

    it("logs the reason and the size that tripped the limit", async () => {
      // The reason and its detail payload reach no tool output — this log is their
      // only observable, so assert it or the classification is untested.
      const debug = vi.spyOn(logger, "debug");
      try {
        await buildCodeGraph(fixture.root, undefined, freshProgress());
        expect(debug).toHaveBeenCalledWith(
          "Skipping file in graph build",
          expect.objectContaining({
            file: "src/huge.ts",
            reason: "oversized",
            size: oversizedTs().length,
            limit: MAX_GRAPH_FILE_BYTES,
          }),
        );
      } finally {
        debug.mockRestore();
      }
    });
  });

  describe("oversized extensionless import target", () => {
    let fixture: FixtureProject;
    beforeAll(() => {
      vi.stubEnv("INDEX_EXTENSIONLESS", "1");
      fixture = createFixtureProject("skips-extensionless");
      addFileToFixture(fixture.root, "run.py", "import deploy\n");
      addFileToFixture(fixture.root, "deploy", oversizedPy());
    });
    afterAll(() => {
      fixture.cleanup();
      vi.unstubAllEnvs(); // else INDEX_EXTENSIONLESS leaks into the describes below
    });

    it("counts the skip and still labels the placeholder by detected language", async () => {
      const progress = freshProgress();
      const graph = await buildCodeGraph(fixture.root, undefined, progress);

      expect(progress.filesSkipped).toBe(1);
      const target = graph.nodes.find((n) => n.relativePath === "deploy");
      expect(target?.language).toBe("python");
    });
  });

  describe("extensionless file whose tail reads as another language", () => {
    let fixture: FixtureProject;
    beforeAll(() => {
      vi.stubEnv("INDEX_EXTENSIONLESS", "1");
      fixture = createFixtureProject("skips-window");
      // Python inside the first DETECT_HEAD_BYTES, shell markers past them.
      // Discovery scores the head; the build re-detects on the bytes it read. Both
      // score the same window, so they agree and the file is kept — dropping the
      // window on either side would make them disagree about unchanged content.
      addFileToFixture(
        fixture.root,
        "wide_script",
        `def configure(conf):\n    return 1\n${"# pad\n".repeat(1500)}${
          "if [ -d /tmp ]; then\n  export PATH=/bin\nfi\n".repeat(20)
        }`,
      );
    });
    afterAll(() => {
      fixture.cleanup();
      vi.unstubAllEnvs();
    });

    it("keeps it under the language its head detects, and counts no skip", async () => {
      const progress = freshProgress();
      const graph = await buildCodeGraph(fixture.root, undefined, progress);

      const node = graph.nodes.find((n) => n.relativePath === "wide_script");
      expect(node?.language).toBe("python");
      expect(progress.filesSkipped).toBeUndefined();
    });
  });

  describe("unreadable file", () => {
    let fixture: FixtureProject;
    let abs: string;
    beforeAll(() => {
      fixture = createFixtureProject("skips-eacces");
      // Must be extension-bearing: discovery head-reads extensionless files, so a
      // mode-000 extensionless file is rejected there and never reaches the read
      // guard this test is pinning.
      addFileToFixture(fixture.root, "src/secret.ts", "export const a = 1;\n");
      abs = path.join(fixture.root, "src/secret.ts");
    });
    afterAll(() => fixture.cleanup());

    it.skipIf(!canTestPermissionDenied)(
      "counts an EACCES read failure as processed and skipped",
      async () => {
        fs.chmodSync(abs, 0o000);
        try {
          const progress = freshProgress();
          const graph = await buildCodeGraph(fixture.root, undefined, progress);

          expect(graph.nodes.find((n) => n.relativePath === "src/secret.ts")).toBeUndefined();
          expect(progress.filesProcessed).toBe(progress.filesTotal);
          expect(progress.filesSkipped).toBe(1);
        } finally {
          fs.chmodSync(abs, 0o644);
        }
      },
    );

    it.skipIf(!canTestPermissionDenied)(
      "classifies it read-failed rather than vanished, with the error text",
      async () => {
        // Only the log distinguishes a real fault from ENOENT — both count as one
        // skip — so inverting that check is invisible without this assertion.
        const debug = vi.spyOn(logger, "debug");
        fs.chmodSync(abs, 0o000);
        try {
          await buildCodeGraph(fixture.root, undefined, freshProgress());
          expect(debug).toHaveBeenCalledWith(
            "Skipping file in graph build",
            expect.objectContaining({
              file: "src/secret.ts",
              reason: "read-failed",
              error: expect.stringContaining("EACCES"),
            }),
          );
        } finally {
          fs.chmodSync(abs, 0o644);
          debug.mockRestore();
        }
      },
    );
  });

  describe("clean project", () => {
    let fixture: FixtureProject;
    beforeAll(() => {
      fixture = createFixtureProject("skips-clean");
    });
    afterAll(() => fixture.cleanup());

    it("leaves filesSkipped undefined when nothing was skipped", async () => {
      const progress = freshProgress();
      await buildCodeGraph(fixture.root, undefined, progress);

      expect(progress.filesProcessed).toBe(progress.filesTotal);
      expect(progress.filesSkipped).toBeUndefined();
    });
  });
});
