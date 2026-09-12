// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addFileToFixture, createFixtureProject, type FixtureProject } from "../helpers/fixtures.js";

/**
 * What a rebuild does when files move underneath it.
 *
 * The build reads some sources twice, so an edit landing between those reads
 * produces a graph whose resolver half and node half describe different
 * content. The recorder refuses to seal a record for that; this covers what the
 * rebuild does with the refusal — a bounded retry from a fresh scan, and on
 * giving up, no replacement of either the cached or the persisted graph.
 */
const moving = vi.hoisted(() => ({ failuresLeft: 0, sealAttempts: 0, throwOther: false }));

vi.mock("../../src/services/graph-inputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/graph-inputs.js")>();
  return {
    ...actual,
    createGraphInputRecorder: (projectRoot: string) => {
      const real = actual.createGraphInputRecorder(projectRoot);
      return {
        ...real,
        finish: (extras: ReadonlySet<string>, capabilities: string) => {
          moving.sealAttempts++;
          if (moving.throwOther) throw new TypeError("something genuinely broken");
          if (moving.failuresLeft > 0) {
            moving.failuresLeft--;
            throw new actual.GraphInputsMovedDuringBuild(
              new Map([["src/index.ts", "read twice, with different content each time"]]),
            );
          }
          return real.finish(extras, capabilities);
        },
      };
    },
  };
});

const saved = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/services/qdrant.js", () => ({
  saveGraphData: vi.fn(async () => {
    saved.calls++;
  }),
  loadGraphData: vi.fn(async () => null),
  loadGraphInputs: vi.fn(async () => ({ status: "absent" })),
  getGraphMetadata: vi.fn(async () => null),
  deleteGraphData: vi.fn(async () => undefined),
  describeQdrantError: (err: unknown) => String(err),
}));

describe("a graph build whose files will not hold still", () => {
  let fixture: FixtureProject;

  beforeAll(async () => {
    const { ensureDynamicLanguages } = await import("../../src/services/code-graph.js");
    ensureDynamicLanguages();
    fixture = createFixtureProject("graph-consistency");
    addFileToFixture(fixture.root, "src/only.ts", "export const only = 1;\n");
  });

  afterAll(() => fixture.cleanup());

  beforeEach(() => {
    moving.failuresLeft = 0;
    moving.sealAttempts = 0;
    moving.throwOther = false;
    saved.calls = 0;
  });

  it("retries from a fresh scan and persists the first consistent attempt", async () => {
    const { rebuildGraph } = await import("../../src/services/code-graph.js");
    moving.failuresLeft = 2;

    const graph = await rebuildGraph(fixture.root, { skipSymbolGraph: true });

    expect(graph.nodes.length).toBeGreaterThan(0);
    // Two attempts abandoned, the third sealed — and only that one was written.
    expect(moving.sealAttempts).toBe(3);
    expect(saved.calls).toBe(1);
  });

  it("gives up after the bounded retry without persisting anything", async () => {
    const { rebuildGraph } = await import("../../src/services/code-graph.js");
    moving.failuresLeft = Number.POSITIVE_INFINITY;

    await expect(rebuildGraph(fixture.root, { skipSymbolGraph: true })).rejects.toThrow(
      /changed while the graph was being built/,
    );
    // Bounded: it stops trying rather than spinning on a tree that keeps moving.
    expect(moving.sealAttempts).toBe(3);
    expect(saved.calls).toBe(0);
  });

  it("leaves the previous graph in place when it gives up", async () => {
    // The rebuild must not clear what it cannot replace: a tree under constant
    // change would otherwise cost the project its graph entirely.
    const { hasGraph, rebuildGraph } = await import("../../src/services/code-graph.js");

    await rebuildGraph(fixture.root, { skipSymbolGraph: true });
    expect(saved.calls).toBe(1);
    await expect(hasGraph(fixture.root)).resolves.toBe(true);

    moving.failuresLeft = Number.POSITIVE_INFINITY;
    await expect(rebuildGraph(fixture.root, { skipSymbolGraph: true })).rejects.toThrow();

    // Nothing new written, and the graph the last good build left is still served.
    expect(saved.calls).toBe(1);
    await expect(hasGraph(fixture.root)).resolves.toBe(true);
  });

  it("does not retry, or swallow, a failure that is not files moving", async () => {
    // The retry is for one specific transient condition. Anything else comes
    // straight out on the first attempt — otherwise a real defect gets three
    // goes and then a shrug, three times slower than before.
    const { rebuildGraph } = await import("../../src/services/code-graph.js");
    moving.throwOther = true;

    await expect(rebuildGraph(fixture.root, { skipSymbolGraph: true })).rejects.toThrow(TypeError);
    expect(moving.sealAttempts).toBe(1);
    expect(saved.calls).toBe(0);
  });
});
