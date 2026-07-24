// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { describe, expect, it } from "vitest";
import { generateMermaidDiagram, getGraphStats } from "../../src/services/graph-analysis.js";
import type { CodeGraph, CodeGraphNode } from "../../src/types.js";

function node(relativePath: string, language?: string): CodeGraphNode {
  return {
    filePath: `/proj/${relativePath}`,
    relativePath,
    imports: [],
    exports: [],
    dependencies: [],
    dependents: [],
    ...(language ? { language } : {}),
  };
}

describe("getGraphStats language breakdown", () => {
  it("counts a stored language for an extensionless node instead of plaintext", () => {
    const graph: CodeGraph = { nodes: [node("scripts/deploy", "shell")], edges: [] };
    const stats = getGraphStats(graph);
    expect(stats.languageBreakdown.shell).toBe(1);
    expect(stats.languageBreakdown.plaintext).toBeUndefined();
  });

  it("falls back to plaintext for an extensionless node with no stored language", () => {
    const graph: CodeGraph = { nodes: [node("scripts/legacy")], edges: [] };
    const stats = getGraphStats(graph);
    expect(stats.languageBreakdown.plaintext).toBe(1);
  });

  it("still derives extensioned files from their path", () => {
    const graph: CodeGraph = { nodes: [node("src/app.ts")], edges: [] };
    const stats = getGraphStats(graph);
    expect(stats.languageBreakdown.typescript).toBe(1);
  });
});

describe("generateMermaidDiagram language colouring", () => {
  it("colours an extensionless node by its stored language", () => {
    const graph: CodeGraph = { nodes: [node("scripts/deploy", "shell")], edges: [] };
    const mermaid = generateMermaidDiagram(graph);
    expect(mermaid).toContain("fill:#4EAA25"); // the shell colour
  });

  it("uses the default colour for an extensionless node with no stored language", () => {
    const graph: CodeGraph = { nodes: [node("scripts/legacy")], edges: [] };
    const mermaid = generateMermaidDiagram(graph);
    expect(mermaid).toContain("fill:#607D8B"); // default grey for the plaintext fallback
  });
});
