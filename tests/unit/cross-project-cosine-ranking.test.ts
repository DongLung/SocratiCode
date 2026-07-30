// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * Issue #94: cross-project search ordered results by their rank inside their own
 * collection, so the top hit of a small project always beat the second hit of a
 * large one however weak it was, and every fused score was capped at
 * 1/(60+0+1) = 0.0164 — six times below the documented SEARCH_MIN_SCORE default
 * of 0.10, which silently discarded every cross-project result.
 *
 * Ranking now uses cosine similarity when each hit carries one, and falls back
 * to the original fusion when they do not, so existing callers are unaffected.
 */

import { describe, expect, it } from "vitest";
import { SEARCH_MIN_SCORE } from "../../src/constants.js";
import { mergeMultiCollectionResults } from "../../src/services/qdrant.js";
import type { SearchResult } from "../../src/types.js";

/** A hit as the fusion path produces it: an RRF `score`, no cosine. */
function rrfHit(relativePath: string, score: number): SearchResult {
  return {
    filePath: `/project/${relativePath}`,
    relativePath,
    content: `content of ${relativePath}`,
    startLine: 1,
    endLine: 10,
    language: "typescript",
    score,
  };
}

/** A hit carrying the cosine the cross-project path now requests. */
function cosineHit(relativePath: string, denseScore: number, score = 0.5): SearchResult {
  return { ...rrfHit(relativePath, score), denseScore };
}

describe("cross-project ranking by cosine (#94)", () => {
  it("ranks by match strength, not by position within each collection", () => {
    // The reported case: a weak hit that happens to be rank 0 of a small repo
    // used to tie the strongest hit and beat the second-strongest of a big one.
    const merged = mergeMultiCollectionResults(
      [
        { label: "big-repo", results: [cosineHit("docs/OVERVIEW.md", 0.91), cosineHit("docs/PIPELINE.md", 0.83)] },
        { label: "small-repo", results: [cosineHit("benchmarks/raw/dump.json", 0.41)] },
      ],
      10,
    );

    expect(merged.map((r) => r.relativePath)).toEqual([
      "docs/OVERVIEW.md",
      "docs/PIPELINE.md",
      "benchmarks/raw/dump.json",
    ]);
    // The specific inversion from the issue: 0.41 must not outrank 0.83.
    const weak = merged.findIndex((r) => r.relativePath === "benchmarks/raw/dump.json");
    const strong = merged.findIndex((r) => r.relativePath === "docs/PIPELINE.md");
    expect(weak).toBeGreaterThan(strong);
  });

  it("produces scores that survive the documented SEARCH_MIN_SCORE default", () => {
    // Under rank fusion the ceiling was 0.0164, so a perfect match was dropped
    // by the 0.10 default and the feature returned nothing at stock settings.
    const merged = mergeMultiCollectionResults(
      [
        { label: "repo-a", results: [cosineHit("src/perfect-match.ts", 0.99)] },
        { label: "repo-b", results: [cosineHit("src/other.ts", 0.62)] },
      ],
      10,
    );

    expect(merged).toHaveLength(2);
    expect(merged.every((r) => r.score >= SEARCH_MIN_SCORE)).toBe(true);
    expect(merged[0].score).toBeCloseTo(0.99, 5);
  });

  it("keeps a file's best chunk rather than accumulating one score per chunk", () => {
    // Rank fusion summed a contribution per matching chunk, so a multi-chunk
    // file outranked a single-chunk one on chunk count rather than relevance.
    const merged = mergeMultiCollectionResults(
      [
        {
          label: "repo-a",
          // Best chunk deliberately LAST: with it first, an implementation that
          // simply keeps whichever it saw first would pass without comparing.
          results: [cosineHit("src/multi.ts", 0.51), cosineHit("src/multi.ts", 0.55), cosineHit("src/multi.ts", 0.60)],
        },
        { label: "repo-b", results: [cosineHit("src/single.ts", 0.70)] },
      ],
      10,
    );

    expect(merged).toHaveLength(2);
    expect(merged[0].relativePath).toBe("src/single.ts");
    // 0.60 and not 0.60+0.55+0.51 — the accumulation is what caused the bias.
    expect(merged[1].score).toBeCloseTo(0.60, 5);
  });

  it("still keeps the same relative path from two projects as separate hits", () => {
    // Behaviour documented in the README and asserted for the fusion path; the
    // cosine path must not start collapsing them.
    const merged = mergeMultiCollectionResults(
      [
        { label: "current-project", results: [cosineHit("src/util.ts", 0.80)] },
        { label: "linked-project", results: [cosineHit("src/util.ts", 0.70)] },
      ],
      10,
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.project)).toEqual(["current-project", "linked-project"]);
  });

  it("does not leak the internal denseScore field into results", () => {
    const merged = mergeMultiCollectionResults([{ label: "a", results: [cosineHit("src/x.ts", 0.9)] }], 10);
    expect(merged[0]).not.toHaveProperty("denseScore");
    expect(merged[0].score).toBeCloseTo(0.9, 5);
  });

  it("respects the limit", () => {
    const merged = mergeMultiCollectionResults(
      [{ label: "a", results: [cosineHit("a.ts", 0.9), cosineHit("b.ts", 0.8), cosineHit("c.ts", 0.7)] }],
      2,
    );
    expect(merged.map((r) => r.relativePath)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("cross-project ranking falls back to fusion (backwards compatibility)", () => {
  it("uses the original rank fusion when no hit carries a cosine", () => {
    // An existing caller passing plain SearchResults — the shape this function
    // has always taken — must get exactly the behaviour it always got.
    const merged = mergeMultiCollectionResults(
      [
        { label: "big-repo", results: [rrfHit("docs/OVERVIEW.md", 0.91), rrfHit("docs/PIPELINE.md", 0.83)] },
        { label: "small-repo", results: [rrfHit("benchmarks/raw/dump.json", 0.41)] },
      ],
      10,
    );

    // The historic RRF values, unchanged: 1/61 for rank 0, 1/62 for rank 1.
    expect(merged[0].score).toBeCloseTo(1 / 61, 6);
    expect(merged.find((r) => r.relativePath === "docs/PIPELINE.md")?.score).toBeCloseTo(1 / 62, 6);
  });

  it("falls back when only some hits carry a cosine, rather than mixing scales", () => {
    // Comparing a cosine against an RRF value would rank two different
    // quantities against each other, so the requirement is all-or-nothing.
    const merged = mergeMultiCollectionResults(
      [
        { label: "a", results: [cosineHit("src/withCosine.ts", 0.95)] },
        { label: "b", results: [rrfHit("src/withoutCosine.ts", 0.5)] },
      ],
      10,
    );

    // Assert the hits survive and carry fusion scores, not just that the values
    // are small: `[]` would also satisfy a bare upper-bound check.
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.relativePath).sort()).toEqual(["src/withCosine.ts", "src/withoutCosine.ts"]);
    // Each is rank 0 of its own collection, so both get the historic 1/61.
    expect(merged.every((r) => Math.abs(r.score - 1 / 61) < 1e-9)).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(mergeMultiCollectionResults([], 10)).toEqual([]);
    expect(mergeMultiCollectionResults([{ label: "a", results: [] }], 10)).toEqual([]);
  });
});
