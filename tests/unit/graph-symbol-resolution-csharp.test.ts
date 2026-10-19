// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import type { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import { extractSymbolsAndCalls, rawCallsToUnresolvedEdges } from "../../src/services/graph-symbols.js";
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

/**
 * The same, end to end: real C# source through the extractor, its edges
 * through the resolver. Every file here shares no `using` with another and
 * the file graph records no dependency, so each target is reached through the
 * project-wide search alone.
 */
describe("C# extractor-to-resolver regressions", () => {
  beforeAll(async () => {
    await ensureDynamicLanguages();
  });

  const run = (files: Record<string, string>) => {
    const symbolsByFile = new Map<string, SymbolNode[]>();
    const edgesByFile = new Map<string, SymbolEdge[]>();
    for (const [file, src] of Object.entries(files)) {
      const out = extractSymbolsAndCalls(src, "csharp" as unknown as Lang, ".cs", file);
      symbolsByFile.set(file, out.symbols);
      edgesByFile.set(file, rawCallsToUnresolvedEdges(out.rawCalls));
    }
    const graph: CodeGraph = {
      nodes: Object.keys(files).map((relativePath) => ({
        relativePath, imports: [], exports: [], dependencies: [], dependents: [], language: "csharp",
      })),
      edges: [],
    };
    resolveCallSites(graph, symbolsByFile, edgesByFile);
    const fullName = new Map<string, string>();
    for (const syms of symbolsByFile.values()) for (const s of syms) fullName.set(s.id, s.csFullName ?? s.qualifiedName);
    /** The edges `file` draws at `line` of `kind` to `calleeName`, with their targets' full names. */
    const at = (file: string, line: number, kind: SymbolEdge["kind"], calleeName: string) =>
      (edgesByFile.get(file) ?? [])
        .filter((e) => e.callSite.line === line && e.kind === kind && e.calleeName === calleeName)
        .map((e) => ({ confidence: e.confidence, targets: e.calleeCandidates.map((id) => fullName.get(id)).sort() }));
    return { at };
  };

  const BILLING = "namespace App.Billing { public class Calc { public static int Compute(int x) => x; public static int Limit = 1; } }";
  const OTHER = "namespace App.Other { public class Calc { public static int Compute(int x) => x; } public class Billing { } }";

  it("answers a namespace-qualified call and type by the namespace written, never a same-named local declaration", () => {
    const caller = [
      "namespace App {",
      "  public class Calc { }",
      "  public class Service {",
      "    int Compute(int x) => x;",
      "    int Run(Billing.Calc c) {",
      "      return Billing.Calc.Compute(1) + Other.Calc.Compute(2) + Billing.Calc.Limit;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const { at } = run({ "Billing/Calc.cs": BILLING, "Other/Calc.cs": OTHER, "Service.cs": caller });
    expect(at("Service.cs", 6, "call", "Compute")).toEqual([
      { confidence: "unique", targets: ["App.Billing.Calc.Compute"] },
      { confidence: "unique", targets: ["App.Other.Calc.Compute"] },
    ]);
    // The parameter type `Billing.Calc` is not the caller's own `App.Calc`.
    expect(at("Service.cs", 5, "type_reference", "Calc")).toEqual([{ confidence: "unique", targets: ["App.Billing.Calc"] }]);
    // The receivers reference `Billing.Calc` (once, for the call and `.Limit`) and `Other.Calc`;
    // none is the caller's own `App.Calc`, and `Billing` is never the class `App.Other.Billing`.
    expect(at("Service.cs", 6, "type_reference", "Calc")).toEqual([
      { confidence: "unique", targets: ["App.Billing.Calc"] },
      { confidence: "unique", targets: ["App.Other.Calc"] },
    ]);
    expect(at("Service.cs", 6, "type_reference", "Billing")).toEqual([]);
  });

  it("resolves a creation outside the dependencies to the constructor, or to the type when it declares none", () => {
    const types = "namespace App { public class Widget { public Widget() { } } public struct Gadget { } }";
    const caller = [
      "namespace App {",
      "  public class Shop {",
      "    void Build() {",
      "      var w = new Widget();",
      "      var g = new Gadget();",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const { at } = run({ "Types.cs": types, "Shop.cs": caller });
    expect(at("Shop.cs", 4, "call", "Widget")).toEqual([{ confidence: "unique", targets: ["App.Widget.Widget"] }]);
    expect(at("Shop.cs", 5, "call", "Gadget")).toEqual([{ confidence: "unique", targets: ["App.Gadget"] }]);
  });

  it("keeps the terminal type of a path whose segments share its spelling", () => {
    const order = "namespace Order { public class Order { } }";
    const caller = "namespace App { public class Desk {\n  void Take(Order.Order o) { }\n} }";
    const { at } = run({ "Order.cs": order, "Desk.cs": caller });
    expect(at("Desk.cs", 2, "type_reference", "Order")).toEqual([{ confidence: "unique", targets: ["Order.Order"] }]);
  });

  it("resolves a project's own framework-named type, bare, qualified and created, and marks .NET's as engine", () => {
    const jobs = "namespace App.Jobs { public class Task { } }";
    const caller = [
      "namespace App {",
      "  public class Runner {",
      "    void Go(Jobs.Task a, System.Threading.Tasks.Task b) {",
      "      var t = new Jobs.Task();",
      "      var l = new List<int>();",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const { at } = run({ "Jobs/Task.cs": jobs, "Runner.cs": caller });
    expect(at("Runner.cs", 3, "type_reference", "Task")).toEqual([
      { confidence: "unique", targets: ["App.Jobs.Task"] },
      { confidence: "engine", targets: [] },
    ]);
    expect(at("Runner.cs", 4, "call", "Task")).toEqual([{ confidence: "unique", targets: ["App.Jobs.Task"] }]);
    expect(at("Runner.cs", 5, "call", "List")).toEqual([{ confidence: "engine", targets: [] }]);
    expect(at("Runner.cs", 5, "type_reference", "List")).toEqual([{ confidence: "engine", targets: [] }]);
  });

  it("answers a qualified call by the class containing the method, when two classes share a line", () => {
    const ab = "namespace App { public class A { public static void M() { } } public class B { public static void M() { } } }";
    const caller = "namespace App { public class C {\n  void Go() { B.M(); }\n} }";
    const { at } = run({ "AB.cs": ab, "C.cs": caller });
    expect(at("C.cs", 2, "call", "M")).toEqual([{ confidence: "unique", targets: ["App.B.M"] }]);
  });

  it("references delegates by name, and the type a static member chain starts from", () => {
    const decls = [
      "namespace App {",
      "  public delegate void Handler(int x);",
      "  public class Config { public static Config Instance { get; } public void Load() { } }",
      "}",
    ].join("\n");
    const caller = "namespace App { public class Host {\n  void Go(Handler h) { Config.Instance.Load(); }\n} }";
    const { at } = run({ "Decls.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Handler")).toEqual([{ confidence: "unique", targets: ["App.Handler"] }]);
    // `Config.Instance` names no type; its longest prefix that does is `Config`.
    expect(at("Host.cs", 2, "type_reference", "Instance")).toEqual([{ confidence: "unique", targets: ["App.Config"] }]);
  });

  it("falls back to a shorter receiver prefix only when that type declares the next segment", () => {
    // `Billing.Rates` is an external namespace and class; the project's own `Billing` has no `Rates`.
    const decls = "namespace App.Other { public class Billing { public static int Total; } }";
    const caller = "namespace App { public class Host {\n  void Go() { Billing.Rates.Load(); }\n} }";
    const { at } = run({ "Billing.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Rates")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("takes a declared field, constant or enum member as the next segment", () => {
    const decls = [
      "namespace App {",
      "  public class OrderState { public static readonly OrderState Open = new(); public int Id; }",
      "  public static class Limits { public const int MaxItems = 100; }",
      "  public enum Mode { Fast, Slow }",
      "}",
    ].join("\n");
    const caller = "namespace App { public class Host {\n  object Go() => (OrderState.Open.Id, Limits.MaxItems.ToString(), Mode.Fast.ToString());\n} }";
    const { at } = run({ "Decls.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Open")).toEqual([{ confidence: "unique", targets: ["App.OrderState"] }]);
    expect(at("Host.cs", 2, "type_reference", "MaxItems")).toEqual([{ confidence: "unique", targets: ["App.Limits"] }]);
    expect(at("Host.cs", 2, "type_reference", "Fast")).toEqual([{ confidence: "unique", targets: ["App.Mode"] }]);
  });

  it("writes a file's using alias out to the path it names", () => {
    const decls = [
      "namespace App.Tests {",
      "  public class ProductStore { public static int Shelf; public static ProductStore Make() => new(); }",
      "}",
    ].join("\n");
    const caller = [
      "using Store = App.Tests.ProductStore;",
      "namespace App { public class Store { public static int Shelf; } public class Host {",
      "  object Go(Store f) => (Store.Shelf.ToString(), Store.Make(), new Store());",
      "} }",
    ].join("\n");
    const { at } = run({ "ProductStore.cs": decls, "Host.cs": caller });
    // Every use of `Store` is the alias, never the same-named `App.Store`.
    expect(at("Host.cs", 3, "type_reference", "ProductStore")).toEqual([{ confidence: "unique", targets: ["App.Tests.ProductStore"] }]);
    expect(at("Host.cs", 3, "type_reference", "Shelf")).toEqual([{ confidence: "unique", targets: ["App.Tests.ProductStore"] }]);
    expect(at("Host.cs", 3, "call", "Make")).toEqual([{ confidence: "unique", targets: ["App.Tests.ProductStore.Make"] }]);
    expect(at("Host.cs", 3, "call", "ProductStore")).toEqual([{ confidence: "unique", targets: ["App.Tests.ProductStore"] }]);
  });

  it("finds a member inherited from a project base, and never one a framework base would declare", () => {
    const decls = [
      "namespace App {",
      "  public class BaseSeeder { public static int Shelf; public static BaseSeeder Create() => new(); }",
      "  public class OrderSeeder : BaseSeeder { }",
      "  public class AppDbContext : DbContext { }",
      "}",
    ].join("\n");
    const caller = [
      "namespace App { public class Host {",
      "  object Go() => (OrderSeeder.Shelf.ToString(), OrderSeeder.Create(), AppDbContext.Database.Name);",
      "} }",
    ].join("\n");
    const { at } = run({ "Decls.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Shelf")).toEqual([{ confidence: "unique", targets: ["App.OrderSeeder"] }]);
    expect(at("Host.cs", 2, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.BaseSeeder.Create"] }]);
    // `Database` would come from EF's `DbContext`, which declares no project symbol.
    expect(at("Host.cs", 2, "type_reference", "Database")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("looks a base up as C# does: own namespace, then usings, and never by name alone", () => {
    // Two modules each declare a `BaseSeeder` with the same members.
    const base = (ns: string) => `namespace ${ns} { public class BaseSeeder { public static int Shelf; public static int Create() => 1; } }`;
    const files = {
      "Orders/BaseSeeder.cs": base("App.Orders"),
      "Other/BaseSeeder.cs": base("App.Other"),
      "Shared/BaseSeeder.cs": base("App.Shared"),
      // Same namespace as `App.Orders.BaseSeeder`, which wins over the imported `App.Shared` one.
      "Orders/OrderSeeder.cs": "using App.Shared;\nnamespace App.Orders { public class OrderSeeder : BaseSeeder { } }",
      // Only `using App.Shared` makes a `BaseSeeder` visible.
      "Billing/BillSeeder.cs": "using App.Shared;\nnamespace App.Billing { public class BillSeeder : BaseSeeder { } }",
      // Two imported `BaseSeeder`s: C# rejects the name as ambiguous.
      "Audit/AuditSeeder.cs": "using App.Shared;\nusing App.Other;\nnamespace App.Audit { public class AuditSeeder : BaseSeeder { } }",
      // No scope or using of this file declares a `BaseSeeder`.
      "Lone/LoneSeeder.cs": "namespace App.Lone { public class LoneSeeder : BaseSeeder { } }",
      "Host.cs": [
        "using App.Orders; using App.Billing; using App.Audit; using App.Lone;",
        "namespace App { public class Host {",
        "  object A() => OrderSeeder.Create();",
        "  object B() => BillSeeder.Create();",
        "  object C() => AuditSeeder.Create();",
        "  object D() => LoneSeeder.Create();",
        "  object E() => LoneSeeder.Shelf.ToString();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    expect(at("Host.cs", 3, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.Orders.BaseSeeder.Create"] }]);
    expect(at("Host.cs", 4, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.Shared.BaseSeeder.Create"] }]);
    expect(at("Host.cs", 5, "call", "Create")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Host.cs", 6, "call", "Create")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Host.cs", 7, "type_reference", "Shelf")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });
});
