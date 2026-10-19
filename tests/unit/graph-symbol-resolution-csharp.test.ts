// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { describe, expect, it } from "vitest";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import type { CodeGraph, SymbolEdge, SymbolNode } from "../../src/types.js";

/**
 * C# qualified calls and type references, at the resolver.
 *
 * `Calc.Compute()` names the class `Calc`; it must reach `Calc.Compute` and
 * never a same-named `Compute` in the caller's own file. A type position
 * names a type, which may sit in the caller's namespace with no `using` and
 * therefore outside the file graph's dependencies, so both are searched in the
 * caller's file, its dependencies, then the whole project.
 */
describe("C# qualified calls and type references at the resolver", () => {
  const CALLER = "src/App/Service.cs";
  const CALC = "src/App/Calc.cs";
  const REPO = "src/Data/IRepo.cs";
  const sym = (file: string, name: string, line: number, kind: SymbolNode["kind"], qualifiedName = name): SymbolNode => ({
    id: `${file}::${name}#${line}`,
    name,
    qualifiedName,
    kind,
    file,
    line,
    endLine: line + 3,
    language: "csharp",
  });
  const node = (relativePath: string, dependencies: string[]) => ({
    relativePath,
    imports: [],
    exports: [],
    dependencies,
    dependents: [],
    language: "csharp",
  });
  // `Service` imports nothing: `Calc` and `IRepo` are reached by name alone.
  const graph: CodeGraph = { nodes: [node(CALLER, []), node(CALC, []), node(REPO, [])], edges: [] };
  const symbols = (): Map<string, SymbolNode[]> =>
    new Map([
      [CALLER, [
        sym(CALLER, "Service", 3, "class"),
        sym(CALLER, "Run", 5, "method", "Service.Run"),
        sym(CALLER, "Compute", 12, "method", "Service.Compute"),
      ]],
      [CALC, [sym(CALC, "Calc", 3, "class"), sym(CALC, "Compute", 5, "method", "Calc.Compute")]],
      [REPO, [sym(REPO, "IRepo", 3, "interface")]],
    ]);
  const edge = (calleeName: string, kind: SymbolEdge["kind"], calleeQualifier?: string): SymbolEdge => ({
    callerId: `${CALLER}::Run#5`,
    calleeName,
    calleeCandidates: [],
    confidence: "unresolved",
    kind,
    callSite: { file: CALLER, line: 7 },
    ...(calleeQualifier ? { calleeQualifier } : {}),
  });

  it("answers a static call by Owner.Name, past a same-named method in the caller's file", () => {
    const e = edge("Compute", "call", "Calc");
    resolveCallSites(graph, symbols(), new Map([[CALLER, [e]]]));
    expect(e.calleeCandidates).toEqual([`${CALC}::Compute#5`]);
    expect(e.confidence).toBe("unique");
  });

  it("keeps a bare call local-first, as before", () => {
    const e = edge("Compute", "call");
    resolveCallSites(graph, symbols(), new Map([[CALLER, [e]]]));
    expect(e.calleeCandidates).toEqual([`${CALLER}::Compute#12`]);
    expect(e.confidence).toBe("local");
  });

  it("leaves a qualified call unresolved when the named class has no such method", () => {
    const e = edge("Compute", "call", "Other");
    resolveCallSites(graph, symbols(), new Map([[CALLER, [e]]]));
    expect(e.calleeCandidates).toEqual([]);
    expect(e.confidence).toBe("unresolved");
  });

  it("resolves a type reference to a class-like symbol anywhere in the project", () => {
    const e = edge("IRepo", "type_reference");
    resolveCallSites(graph, symbols(), new Map([[CALLER, [e]]]));
    expect(e.calleeCandidates).toEqual([`${REPO}::IRepo#3`]);
    expect(e.confidence).toBe("unique");
  });

  it("never answers a type reference with a method of that name", () => {
    const e = edge("Compute", "type_reference");
    resolveCallSites(graph, symbols(), new Map([[CALLER, [e]]]));
    expect(e.calleeCandidates).toEqual([]);
    expect(e.confidence).toBe("unresolved");
  });
});
