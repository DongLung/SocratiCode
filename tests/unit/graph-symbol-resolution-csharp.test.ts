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
    filePath: relativePath,
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
        filePath: relativePath, relativePath, imports: [], exports: [], dependencies: [], dependents: [], language: "csharp",
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
    const jobs = "namespace App.Chores { public class Task { } }";
    const caller = [
      "namespace App {",
      "  public class Runner {",
      "    void Go(Chores.Task a, System.Threading.Tasks.Task b) {",
      "      var t = new Chores.Task();",
      "      var l = new List<int>();",
      "    }",
      "  }",
      "}",
    ].join("\n");
    const { at } = run({ "Chores/Task.cs": jobs, "Runner.cs": caller });
    expect(at("Runner.cs", 3, "type_reference", "Task")).toEqual([
      { confidence: "unique", targets: ["App.Chores.Task"] },
      { confidence: "engine", targets: [] },
    ]);
    expect(at("Runner.cs", 4, "call", "Task")).toEqual([{ confidence: "unique", targets: ["App.Chores.Task"] }]);
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
    // `Billing.Tariffs` is an external namespace and class; the project's own `Billing` has no `Tariffs`.
    const decls = "namespace App.Other { public class Billing { public static int Total; } }";
    const caller = "namespace App { public class Host {\n  void Go() { Billing.Tariffs.Load(); }\n} }";
    const { at } = run({ "Billing.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Tariffs")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("takes a declared field, constant or enum member as the next segment", () => {
    const decls = [
      "namespace App {",
      "  public class OrderState { public static readonly OrderState Open = new(); public int Id; }",
      "  public static class Limits { public const int MaxWidgets = 100; }",
      "  public enum Mode { Fast, Slow }",
      "}",
    ].join("\n");
    const caller = "namespace App { public class Host {\n  object Go() => (OrderState.Open.Id, Limits.MaxWidgets.ToString(), Mode.Fast.ToString());\n} }";
    const { at } = run({ "Decls.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Open")).toEqual([{ confidence: "unique", targets: ["App.OrderState"] }]);
    expect(at("Host.cs", 2, "type_reference", "MaxWidgets")).toEqual([{ confidence: "unique", targets: ["App.Limits"] }]);
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
      "  public class HarborSeeder : BaseSeeder { }",
      "  public class AppDbContext : DbContext { }",
      "}",
    ].join("\n");
    const caller = [
      "namespace App { public class Host {",
      "  object Go() => (HarborSeeder.Shelf.ToString(), HarborSeeder.Create(), AppDbContext.Database.Name);",
      "} }",
    ].join("\n");
    const { at } = run({ "Decls.cs": decls, "Host.cs": caller });
    expect(at("Host.cs", 2, "type_reference", "Shelf")).toEqual([{ confidence: "unique", targets: ["App.HarborSeeder"] }]);
    expect(at("Host.cs", 2, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.BaseSeeder.Create"] }]);
    // `Database` would come from EF's `DbContext`, which declares no project symbol.
    expect(at("Host.cs", 2, "type_reference", "Database")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("looks a base up as C# does: own namespace, then usings, and never by name alone", () => {
    // Two modules each declare a `BaseSeeder` with the same members.
    const base = (ns: string) => `namespace ${ns} { public class BaseSeeder { public static int Shelf; public static int Create() => 1; } }`;
    const files = {
      "Harbor/BaseSeeder.cs": base("App.Harbor"),
      "Other/BaseSeeder.cs": base("App.Other"),
      "Shared/BaseSeeder.cs": base("App.Shared"),
      // Same namespace as `App.Harbor.BaseSeeder`, which wins over the imported `App.Shared` one.
      "Harbor/HarborSeeder.cs": "using App.Shared;\nnamespace App.Harbor { public class HarborSeeder : BaseSeeder { } }",
      // Only `using App.Shared` makes a `BaseSeeder` visible.
      "Billing/BillSeeder.cs": "using App.Shared;\nnamespace App.Billing { public class BillSeeder : BaseSeeder { } }",
      // Two imported `BaseSeeder`s: C# rejects the name as ambiguous.
      "Kiosk/KioskSeeder.cs": "using App.Shared;\nusing App.Other;\nnamespace App.Kiosk { public class KioskSeeder : BaseSeeder { } }",
      // No scope or using of this file declares a `BaseSeeder`.
      "Lone/LoneSeeder.cs": "namespace App.Lone { public class LoneSeeder : BaseSeeder { } }",
      "Host.cs": [
        "using App.Harbor; using App.Billing; using App.Kiosk; using App.Lone;",
        "namespace App { public class Host {",
        "  object A() => HarborSeeder.Create();",
        "  object B() => BillSeeder.Create();",
        "  object C() => KioskSeeder.Create();",
        "  object D() => LoneSeeder.Create();",
        "  object E() => LoneSeeder.Shelf.ToString();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    expect(at("Host.cs", 3, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.Harbor.BaseSeeder.Create"] }]);
    expect(at("Host.cs", 4, "call", "Create")).toEqual([{ confidence: "unique", targets: ["App.Shared.BaseSeeder.Create"] }]);
    expect(at("Host.cs", 5, "call", "Create")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Host.cs", 6, "call", "Create")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Host.cs", 7, "type_reference", "Shelf")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("answers a bare type name with the type the caller can see, as C# looks it up", () => {
    const calc = (ns: string) => `namespace ${ns} { public class Calc { public static int Compute() => 1; } }`;
    const use = (n: number) => `  object G${n}(Calc c) => (new Calc(), Calc.Compute());`;
    const files = {
      "Billing/Calc.cs": calc("App.Billing"),
      "Other/Calc.cs": calc("App.Other"),
      "Chores/Task.cs": "namespace App.Chores { public class Task { } }",
      // Its own namespace declares a `Calc`.
      "Billing/Invoice.cs": `namespace App.Billing { public class Invoice {\n${use(1)}\n} }`,
      // Only `using App.Other` makes a `Calc` visible.
      "Shipping/Parcel.cs": `using App.Other;\nnamespace App.Shipping { public class Parcel {\n${use(2)}\n} }`,
      // Two imported `Calc`s: C# rejects the name as ambiguous.
      "Kiosk/Check.cs": `using App.Billing;\nusing App.Other;\nnamespace App.Kiosk { public class Check {\n${use(3)}\n} }`,
      // No scope or using of this file declares a `Calc`, nor a `Task`.
      "Lone/Lone.cs": `namespace App.Lone { public class Lone {\n${use(4)}\n  System.Threading.Tasks.Task T() => null; Task U() => null;\n} }`,
      // A `global using` counts in its own file. Which other files share its
      // compilation is the project system's to say, so none is assumed.
      "Tests/GlobalUsings.cs": `global using App.Billing;\nnamespace App.Tests { public class Fixture {\n${use(6)}\n} }`,
      "Tests/Unit/CalcTests.cs": `namespace App.Tests { public class CalcTests {\n${use(5)}\n} }`,
    };
    const { at } = run(files);
    const all = (file: string, line: number) => [
      ...at(file, line, "type_reference", "Calc"),
      ...at(file, line, "call", "Calc"),
      ...at(file, line, "call", "Compute"),
    ];
    const billing = ["App.Billing.Calc"];
    // `Calc c`, `new Calc()` and the receiver `Calc.` are one reference: one per name and line.
    expect(all("Billing/Invoice.cs", 2)).toEqual([
      { confidence: "unique", targets: billing },
      { confidence: "unique", targets: billing },
      { confidence: "unique", targets: ["App.Billing.Calc.Compute"] },
    ]);
    expect(all("Shipping/Parcel.cs", 3).map((e) => e.targets)).toEqual([["App.Other.Calc"], ["App.Other.Calc"], ["App.Other.Calc.Compute"]]);
    expect(all("Kiosk/Check.cs", 4)).toEqual([
      { confidence: "unresolved", targets: [] },
      { confidence: "unresolved", targets: [] },
      { confidence: "unresolved", targets: [] },
    ]);
    expect(all("Lone/Lone.cs", 2).map((e) => e.confidence)).toEqual(["unresolved", "unresolved", "unresolved"]);
    expect(all("Tests/GlobalUsings.cs", 3).map((e) => e.targets)).toEqual([billing, billing, ["App.Billing.Calc.Compute"]]);
    expect(all("Tests/Unit/CalcTests.cs", 2).map((e) => e.confidence)).toEqual(["unresolved", "unresolved", "unresolved"]);
    // `App.Chores.Task` is a project type, but not one this file can see: both `Task`s are .NET's.
    expect(at("Lone/Lone.cs", 3, "type_reference", "Task")).toEqual([
      { confidence: "engine", targets: [] },
      { confidence: "engine", targets: [] },
    ]);
  });

  it("sees the nested types a using static imports, and those a base class declares", () => {
    const files = {
      "Data/Atlas.cs": "namespace App.Data { public static class Atlas { public static class Groups { public static int Items; } } }",
      "Data/Other.cs": "namespace App.Other { public static class Groups { public static int Items; } }",
      "Base/Store.cs": "namespace App.Base { public class Store { public class Seed { } } }",
      "Tests/T.cs": [
        "using static App.Data.Atlas;",
        "using App.Base;",
        "namespace App.Tests { public class T : Store {",
        "  object Go(Seed s) => Groups.Items.ToString();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    // `Groups` is `Atlas.Groups`, imported by `using static` — not `App.Other.Groups`.
    expect(at("Tests/T.cs", 4, "type_reference", "Items")).toEqual([{ confidence: "unique", targets: ["App.Data.Atlas.Groups"] }]);
    // `Seed` is nested in the base class `Store`, visible by simple name inside `T`.
    expect(at("Tests/T.cs", 4, "type_reference", "Seed")).toEqual([{ confidence: "unique", targets: ["App.Base.Store.Seed"] }]);
  });

  it("never widens a written namespace to another whose name ends the same", () => {
    const files = {
      "App/Calc.cs": "namespace App.Billing { public class Calc { public static int Compute() => 1; } }",
      "Legacy/Calc.cs": "namespace Legacy.Billing { public class Calc { public static int Compute() => 2; } }",
      // `Billing.Calc` from `Legacy.Shop` is `Legacy.Billing.Calc`, the enclosing namespace's.
      "Legacy/Shop.cs": "namespace Legacy.Shop { public class Shop {\n  int Go() => Billing.Calc.Compute();\n} }",
      // From `Tools` no scope or import declares a `Billing`: nothing is answered.
      "Tools/Tool.cs": "namespace Tools { public class Tool {\n  int Go(Billing.Calc c) => Billing.Calc.Compute();\n} }",
    };
    const { at } = run(files);
    expect(at("Legacy/Shop.cs", 2, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Legacy.Billing.Calc.Compute"] }]);
    expect(at("Legacy/Shop.cs", 2, "type_reference", "Calc")).toEqual([{ confidence: "unique", targets: ["Legacy.Billing.Calc"] }]);
    expect(at("Tools/Tool.cs", 2, "call", "Compute")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Tools/Tool.cs", 2, "type_reference", "Calc")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("looks a global::-anchored path up from the global namespace alone", () => {
    const files = {
      "Root/Calc.cs": "namespace Billing { public class Calc { public static int Compute() => 1; } }",
      "App/Calc.cs": "namespace App.Billing { public class Calc { public static int Compute() => 2; } }",
      "App/Shop.cs": [
        "namespace App { public class Shop {",
        "  int A() => Billing.Calc.Compute();",
        "  int B(global::Billing.Calc c) => global::Billing.Calc.Compute();",
        "  int C() => global::App.Billing.Calc.Compute() + new global::Billing.Calc().GetHashCode();",
        "  int D() => global::Calc.Compute();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    // Unanchored, the enclosing namespace `App` is searched first.
    expect(at("App/Shop.cs", 2, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["App.Billing.Calc.Compute"] }]);
    expect(at("App/Shop.cs", 3, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Billing.Calc.Compute"] }]);
    expect(at("App/Shop.cs", 3, "type_reference", "Calc")).toEqual([{ confidence: "unique", targets: ["Billing.Calc"] }]);
    expect(at("App/Shop.cs", 4, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["App.Billing.Calc.Compute"] }]);
    expect(at("App/Shop.cs", 4, "call", "Calc")).toEqual([{ confidence: "unique", targets: ["Billing.Calc"] }]);
    // The global namespace declares no `Calc`.
    expect(at("App/Shop.cs", 5, "call", "Compute")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("answers this. and base. by the caller's own type and its bases, and no other receiver", () => {
    const files = {
      "Base.cs": "namespace App { public class Base { public int Load() => 1; public int Save() => 1; } }",
      "Calc.cs": "namespace App { public class Calc { public int Load() => 2; public static Calc Make() => null; } }",
      "Repo.cs": [
        "namespace App { public class Repo : Base {",
        "  public new int Load() => 3;",
        "  int Go(Calc calc) => this.Load() + base.Load() + this.Save();",
        "  int Other(Calc calc) => calc.Load() + Calc.Make().Load() + calc?.Load() ?? 0;",
        "  int Lower(Calc calc) => calc.Load();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    expect(at("Repo.cs", 3, "call", "Load")).toEqual([
      { confidence: "local", targets: ["App.Repo.Load"] },
      { confidence: "unique", targets: ["App.Base.Load"] },
    ]);
    // `this.Save()` is inherited from `Base`.
    expect(at("Repo.cs", 3, "call", "Save")).toEqual([{ confidence: "unique", targets: ["App.Base.Save"] }]);
    // A variable, a call result or `?.` names no type the source spells out.
    expect(at("Repo.cs", 4, "call", "Load").map((e) => e.confidence)).toEqual(["unresolved", "unresolved", "unresolved"]);
    // A lowercase receiver is never a type reference.
    expect(at("Repo.cs", 5, "type_reference", "calc")).toEqual([]);
  });

  it("applies a namespace block's usings and aliases to that block alone", () => {
    const files = {
      "Billing/Calc.cs": "namespace App.Billing { public class Calc { public static int Compute() => 1; } }",
      "Other/Calc.cs": "namespace App.Other { public class Calc { public static int Compute() => 2; } }",
      "Both.cs": [
        "namespace First { using App.Billing; using C = App.Billing.Calc; public class A {",
        "  int Go(Calc x) => Calc.Compute() + C.Compute();",
        "} }",
        "namespace Second { using App.Other; using C = App.Other.Calc; public class B {",
        "  int Go(Calc x) => Calc.Compute() + C.Compute();",
        "} }",
        "namespace Third { public class D {",
        "  int Go(Calc x) => Calc.Compute();",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    const targets = (line: number) => at("Both.cs", line, "call", "Compute").map((e) => e.targets);
    expect(targets(2)).toEqual([["App.Billing.Calc.Compute"], ["App.Billing.Calc.Compute"]]);
    expect(targets(5)).toEqual([["App.Other.Calc.Compute"], ["App.Other.Calc.Compute"]]);
    // A sibling block's imports do not reach this one.
    expect(at("Both.cs", 8, "call", "Compute")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Both.cs", 8, "type_reference", "Calc")).toEqual([{ confidence: "unresolved", targets: [] }]);
  });

  it("consults a namespace block's imports before any outer namespace, and the file's after the global one", () => {
    const files = {
      "Root.cs": "public class Calc { public static int Compute() => 0; }",
      "Vendor.cs": "namespace Vendor { public class Calc { public static int Compute() => 1; } }",
      // The block's import is consulted at `App`, before the global `Calc`.
      "Shop.cs": "namespace App { using Vendor; public class Shop {\n  int Go(Calc c) => Calc.Compute();\n} }",
      // A file-level import is consulted only after the global namespace's own types.
      "Top.cs": "using Vendor;\nnamespace App.Top { public class Top {\n  int Go(Calc c) => Calc.Compute();\n} }",
    };
    const { at } = run(files);
    expect(at("Shop.cs", 2, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Vendor.Calc.Compute"] }]);
    expect(at("Shop.cs", 2, "type_reference", "Calc")).toEqual([{ confidence: "unique", targets: ["Vendor.Calc"] }]);
    expect(at("Top.cs", 3, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Calc.Compute"] }]);
    expect(at("Top.cs", 3, "type_reference", "Calc")).toEqual([{ confidence: "unique", targets: ["Calc"] }]);
  });

  it("resolves a block's import from the block's namespace unless anchored, and imports types, not namespaces", () => {
    const files = {
      "AppBilling.cs": "namespace App.Billing { public class Calc { public static int Compute() => 1; } }",
      "RootBilling.cs": "namespace Billing { public class Calc { public static int Compute() => 2; } }",
      "AppTools.cs": "namespace App.Tools { public class Kit { public static int Make() => 3; } }",
      "Shop.cs": [
        "namespace App { using Billing; public class Shop {",
        "  int Go() => Calc.Compute();",
        "} }",
        "namespace App.Root { using global::Billing; public class Root {",
        "  int Go() => Calc.Compute();",
        "} }",
        "namespace Elsewhere { using App; public class Far {",
        "  int Go() => Tools.Kit.Make();",
        "} }",
      ].join("\n"),
      "Top.cs": "using Billing;\nnamespace App.Top { public class Top {\n  int Go() => Calc.Compute();\n} }",
    };
    const { at } = run(files);
    // `using Billing;` inside `namespace App` names `App.Billing`.
    expect(at("Shop.cs", 2, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["App.Billing.Calc.Compute"] }]);
    expect(at("Shop.cs", 5, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Billing.Calc.Compute"] }]);
    // `using App;` imports `App`'s types; `App.Tools` is a namespace, so `Tools.` is not reached through it.
    expect(at("Shop.cs", 8, "call", "Make")).toEqual([{ confidence: "unresolved", targets: [] }]);
    // A file-level import is resolved from the global namespace.
    expect(at("Top.cs", 3, "call", "Compute")).toEqual([{ confidence: "unique", targets: ["Billing.Calc.Compute"] }]);
  });

  it("keeps the imports of namespace blocks written on one line to their own block", () => {
    const files = {
      "X.cs": "namespace Xs { public class Calc { public static int Compute() => 1; } }",
      "Y.cs": "namespace Ys { public class Calc { public static int Compute() => 2; } }",
      "Pair.cs":
        "namespace A { using Xs; class C { int Go() => Calc.Compute(); } } namespace B { using Ys; class D { int Go() => Calc.Compute(); } }",
    };
    const { at } = run(files);
    expect(at("Pair.cs", 1, "call", "Compute")).toEqual([
      { confidence: "unique", targets: ["Xs.Calc.Compute"] },
      { confidence: "unique", targets: ["Ys.Calc.Compute"] },
    ]);
    expect(at("Pair.cs", 1, "type_reference", "Calc")).toEqual([
      { confidence: "unique", targets: ["Xs.Calc"] },
      { confidence: "unique", targets: ["Ys.Calc"] },
    ]);
  });

  it("leaves a path through an extern alias unresolved", () => {
    const files = {
      "Billing/Calc.cs": "namespace App.Billing { public class Calc { public static int Compute() => 1; } }",
      "Shop.cs": "extern alias Legacy;\nnamespace App { public class Shop {\n  int Go(Legacy::App.Billing.Calc c) => Legacy::App.Billing.Calc.Compute();\n} }",
    };
    const { at } = run(files);
    // The alias names another assembly's copy, which the graph does not hold.
    expect(at("Shop.cs", 3, "call", "Compute")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Shop.cs", 3, "type_reference", "Calc")).toEqual([]);
  });

  it("marks a framework static call as engine unless a visible project type shadows its class", () => {
    const files = {
      "Util/Math.cs": "namespace App.Util { public static class Math { public static int Clamp(int x) => x; } }",
      "Plain.cs": "namespace App.Plain { public class P {\n  int Go() => Math.Max(1, 2) + System.Math.Min(1, 2);\n} }",
      "Shadow.cs": "using App.Util;\nnamespace App.Shadow { public class S {\n  int Go() => Math.Max(1, 2) + Math.Clamp(1);\n} }",
    };
    const { at } = run(files);
    expect(at("Plain.cs", 2, "call", "Max")).toEqual([{ confidence: "engine", targets: [] }]);
    expect(at("Plain.cs", 2, "call", "Min")).toEqual([{ confidence: "engine", targets: [] }]);
    // The visible project `Math` declares no `Max`: neither .NET's nor a guess.
    expect(at("Shadow.cs", 3, "call", "Max")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Shadow.cs", 3, "call", "Clamp")).toEqual([{ confidence: "unique", targets: ["App.Util.Math.Clamp"] }]);
  });

  it("takes a framework name as a framework type only alone or under System, never as a member", () => {
    const files = {
      "Paths.cs": [
        "namespace App { public class Paths {",
        "  object Go(Kiosk kiosk) => Kiosk.Action.Invoke() + Settings.Environment.Get() + System.Math.Abs(1) + Math.PI;",
        "} }",
      ].join("\n"),
    };
    const { at } = run(files);
    // `Kiosk` and `Settings` are no visible types: `Action` and `Environment` are their members.
    expect(at("Paths.cs", 2, "call", "Invoke")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Paths.cs", 2, "call", "Get")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Paths.cs", 2, "type_reference", "Environment")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Paths.cs", 2, "call", "Abs")).toEqual([{ confidence: "engine", targets: [] }]);
    expect(at("Paths.cs", 2, "type_reference", "Math")).toEqual([
      { confidence: "engine", targets: [] },
      { confidence: "engine", targets: [] },
    ]);
  });

  it("draws no type reference from a tuple element's label", () => {
    const files = {
      "Total.cs": "namespace App { public class Total { } public class Order { } }",
      "Desk.cs": "namespace App { public class Desk {\n  (int Total, Order Item) Go((Order First, int Total) p) => default;\n} }",
    };
    const { at } = run(files);
    expect(at("Desk.cs", 2, "type_reference", "Total")).toEqual([]);
    expect(at("Desk.cs", 2, "type_reference", "Item")).toEqual([]);
    expect(at("Desk.cs", 2, "type_reference", "Order")).toEqual([{ confidence: "unique", targets: ["App.Order"] }]);
  });

  it("looks each base up once, so nested types cost no more than their count, and ends a cyclic hierarchy", () => {
    // Every enclosing type's bases are searched for each nested one: without
    // reuse, 16 levels of 4 bases would take hours.
    const lines = ["namespace App {", "  public interface K0 { } public interface K1 { } public interface K2 { } public interface K3 { }"];
    for (let i = 0; i < 16; i++) lines.push(`  public class O${i} : K0, K1, K2, K3 {`);
    lines.push("    Missing m;", ...Array.from({ length: 16 }, () => "  }"));
    lines.push("  public class Ping : Pong { int Go() => this.Run(); }", "  public class Pong : Ping { public int Run() => 1; }", "}");
    const started = Date.now();
    const { at } = run({ "Nest.cs": lines.join("\n") });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(at("Nest.cs", 19, "type_reference", "Missing")).toEqual([{ confidence: "unresolved", targets: [] }]);
    expect(at("Nest.cs", 36, "call", "Run")).toEqual([{ confidence: "local", targets: ["App.Pong.Run"] }]);
  });

  it("answers a call through a lowercase namespace by that namespace, never a same-named local method", () => {
    const files = {
      "Lib/Calc.cs": "namespace vendor.tools { public class Calc { public static int Compute() => 1; } }",
      "Shop.cs": "namespace App { public class Shop {\n  int Compute() => 0;\n  int Go() => vendor.tools.Calc.Compute() + nowhere.Calc.Compute();\n} }",
    };
    const { at } = run(files);
    expect(at("Shop.cs", 3, "call", "Compute")).toEqual([
      { confidence: "unique", targets: ["vendor.tools.Calc.Compute"] },
      { confidence: "unresolved", targets: [] },
    ]);
  });
});
