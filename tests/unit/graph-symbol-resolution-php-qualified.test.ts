// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { describe, expect, it } from "vitest";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import type { CodeGraph, SymbolEdge, SymbolNode } from "../../src/types.js";

/**
 * PHP qualified edges, at the resolver.
 *
 * A qualified PHP edge carries the class a static call names, or the namespace
 * a class reference names, and every PHP class and method carries what
 * declares it. Resolution requires the two to match — in the caller's own file
 * first, then across its dependencies, then anywhere in the project — and
 * leaves the edge `unresolved` when they do not, rather than falling back to
 * the name.
 */
describe("PHP qualified edges at the resolver", () => {
  const CALLER = "src/Schema/Schema.php";
  const USERS = "src/Schema/UserSchema.php";
  const ORDERS = "src/Schema/OrderSchema.php";
  const INVOICE = "src/Models/Invoice.php";
  const UNREACHED = "src/Elsewhere/Report.php";

  const sym = (file: string, name: string, line: number, kind: SymbolNode["kind"], phpOwner?: string): SymbolNode => ({
    id: `${file}::${name}#${line}`,
    name,
    qualifiedName: name,
    kind,
    file,
    line,
    endLine: line + 3,
    language: "php",
    ...(phpOwner ? { phpOwner } : {}),
  });

  const node = (relativePath: string, dependencies: string[]) => ({
    relativePath,
    imports: [],
    exports: [],
    dependencies,
    dependents: [],
  });

  // `Schema` reaches the two sibling schemas and `Invoice`; `Report` is in the
  // project but not among the caller's dependencies.
  const graph: CodeGraph = {
    nodes: [
      node(CALLER, [USERS, ORDERS, INVOICE]),
      node(USERS, []),
      node(ORDERS, []),
      node(INVOICE, []),
      node(UNREACHED, []),
    ],
    edges: [],
  };

  const symbols = (): Map<string, SymbolNode[]> => new Map([
    [CALLER, [
      sym(CALLER, "Schema", 5, "class", "\\App\\Schema\\"),
      sym(CALLER, "all", 7, "method", "\\App\\Schema\\Schema"),
      sym(CALLER, "helper", 12, "method", "\\App\\Schema\\Schema"),
    ]],
    [USERS, [
      sym(USERS, "UserSchema", 5, "class", "\\App\\Schema\\"),
      sym(USERS, "all", 7, "method", "\\App\\Schema\\UserSchema"),
    ]],
    [ORDERS, [
      sym(ORDERS, "OrderSchema", 5, "class", "\\App\\Schema\\"),
      sym(ORDERS, "all", 7, "method", "\\App\\Schema\\OrderSchema"),
    ]],
    [INVOICE, [
      sym(INVOICE, "Invoice", 5, "class", "\\App\\Models\\"),
      sym(INVOICE, "capture", 7, "method", "\\App\\Models\\Invoice"),
      // What a graph persisted before owners existed would hold.
      sym(INVOICE, "legacy", 12, "method"),
    ]],
    [UNREACHED, [
      sym(UNREACHED, "Report", 5, "class", "\\App\\Elsewhere\\"),
      sym(UNREACHED, "build", 7, "method", "\\App\\Elsewhere\\Report"),
    ]],
  ]);

  /** Resolve one edge written inside `Schema::all()` and return it. */
  const resolve = (calleeName: string, calleeQualifier?: string, kind: SymbolEdge["kind"] = "call"): SymbolEdge => {
    const edge: SymbolEdge = {
      callerId: `${CALLER}::all#7`,
      calleeName,
      calleeCandidates: [],
      confidence: "unresolved",
      kind,
      ...(calleeQualifier ? { calleeQualifier } : {}),
      callSite: { file: CALLER, line: 8 },
    };
    resolveCallSites(graph, symbols(), new Map([[CALLER, [edge]]]));
    return edge;
  };

  it("resolves a qualified call to the method the named class declares, across files", () => {
    const edge = resolve("all", "\\App\\Schema\\UserSchema");
    expect(edge.calleeCandidates).toEqual([`${USERS}::all#7`]);
    expect(edge.confidence).toBe("unique");
  });

  it("picks the right one of two same-named methods in two dependencies", () => {
    const edge = resolve("all", "\\App\\Schema\\OrderSchema");
    expect(edge.calleeCandidates).toEqual([`${ORDERS}::all#7`]);
    expect(edge.confidence).toBe("unique");
  });

  it("cannot become a self-edge because the caller declares a method of the same name", () => {
    // `Schema::all()` calling `UserSchema::all()`: the caller's own `all` is
    // owned by `Schema`, so it is not a candidate, and the answer is not `local`.
    const edge = resolve("all", "\\App\\Schema\\UserSchema");
    expect(edge.calleeCandidates).not.toContain(`${CALLER}::all#7`);
    expect(edge.confidence).not.toBe("local");
  });

  it("resolves in the caller's own file when the named class is declared there", () => {
    const edge = resolve("helper", "\\App\\Schema\\Schema");
    expect(edge.calleeCandidates).toEqual([`${CALLER}::helper#12`]);
    expect(edge.confidence).toBe("local");
  });

  it("leaves a call to a class it cannot find unresolved, rather than falling back to the name", () => {
    // `Request::capture()` naming Illuminate's `Request`: a `capture` is right
    // there in a dependency, but it is `Invoice`'s, and the name alone is what
    // drew the wrong-class edge.
    const edge = resolve("capture", "\\Illuminate\\Http\\Request");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("leaves a call unresolved when the class is found but declares no such method", () => {
    const edge = resolve("missing", "\\App\\Models\\Invoice");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("matches the class ASCII-case-insensitively, as PHP does", () => {
    const edge = resolve("all", "\\app\\schema\\USERSCHEMA");
    expect(edge.calleeCandidates).toEqual([`${USERS}::all#7`]);
  });

  it("resolves a class reference to the class in the namespace it names", () => {
    const edge = resolve("Invoice", "\\App\\Models\\", "type_reference");
    expect(edge.calleeCandidates).toEqual([`${INVOICE}::Invoice#5`]);
    expect(edge.confidence).toBe("unique");
  });

  it("matches a class reference's own name ASCII-case-insensitively too", () => {
    // `new \App\models\INVOICE()` is the class declared as `Invoice`: the
    // class name folds with its namespace, whether it sits in the qualifier of
    // a static call or is the name of a class reference.
    const edge = resolve("INVOICE", "\\app\\MODELS\\", "type_reference");
    expect(edge.calleeCandidates).toEqual([`${INVOICE}::Invoice#5`]);
    expect(edge.confidence).toBe("unique");
  });

  it("matches a method name exactly, as every other call is matched", () => {
    expect(resolve("CAPTURE", "\\App\\Models\\Invoice").confidence).toBe("unresolved");
  });

  it("never lets a namespace qualifier answer with a method, or a class qualifier with a class", () => {
    // `\App\Models\Invoice\` is a namespace; `Invoice`'s methods are owned by
    // the class `\App\Models\Invoice`, without the trailing `\`. The two forms
    // cannot meet.
    expect(resolve("capture", "\\App\\Models\\Invoice\\").confidence).toBe("unresolved");
    expect(resolve("Invoice", "\\App\\Models", "type_reference").confidence).toBe("unresolved");
  });

  it("never answers a qualified edge with a symbol that has no owner", () => {
    const edge = resolve("legacy", "\\App\\Models\\Invoice");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("finds a class outside the caller's dependencies by its exact qualified name", () => {
    // `Report` is not among the caller's dependencies — a sibling in its own
    // namespace needs no `use`, so the file graph may draw no edge to it — but
    // the whole qualified name can only reach the class the source names.
    const edge = resolve("build", "\\App\\Elsewhere\\Report");
    expect(edge.calleeCandidates).toEqual([`${UNREACHED}::build#7`]);
    expect(edge.confidence).toBe("unique");
  });

  it("still leaves a method name alone unmatched outside the dependencies", () => {
    // Unqualified, `build()` is answered by name, and only within reach.
    expect(resolve("build").confidence).toBe("unresolved");
  });

  it("resolves an unqualified PHP call exactly as before", () => {
    // `self::all()`, `$obj->all()` or a bare `all()` carries no qualifier, and
    // is answered by name — the caller's own file first.
    const edge = resolve("all");
    expect(edge.calleeCandidates).toEqual([`${CALLER}::all#7`]);
    expect(edge.confidence).toBe("local");
  });
});

/**
 * A static method the named class inherits rather than declares, at the
 * resolver. The class's own methods first, then its traits', then its
 * parent's, and only through declarations the index holds.
 */
describe("PHP inherited static methods at the resolver", () => {
  const CALLER = "src/Http/Caller.php";
  const ENTITY = "src/Models/Entity.php";
  const MODEL = "src/Models/Model.php";
  const USER = "src/Models/User.php";
  const POST = "src/Models/Post.php";
  const TRAITS = "src/Models/Traits.php";
  const LOOP = "src/Models/Loop.php";
  const OTHER = "src/Other/Other.php";
  const TWIN_A = "packages/a/Twin.php";
  const TWIN_B = "packages/b/Twin.php";

  const sym = (file: string, name: string, line: number, kind: SymbolNode["kind"], phpOwner: string, extra: Partial<SymbolNode> = {}): SymbolNode => ({
    id: `${file}::${name}#${line}`,
    name,
    qualifiedName: name,
    kind,
    file,
    line,
    endLine: line + 3,
    language: "php",
    phpOwner,
    ...extra,
  });

  const node = (relativePath: string, dependencies: string[]) => ({
    relativePath,
    imports: [],
    exports: [],
    dependencies,
    dependents: [],
  });

  const graph: CodeGraph = {
    nodes: [CALLER, ENTITY, MODEL, USER, POST, TRAITS, LOOP, OTHER, TWIN_A, TWIN_B].map((f) => node(f, f === CALLER ? [USER, POST, OTHER] : [])),
    edges: [],
  };

  const NS = "\\App\\Models\\";
  const symbols = (): Map<string, SymbolNode[]> => new Map([
    [CALLER, [sym(CALLER, "Caller", 3, "class", "\\App\\Http\\"), sym(CALLER, "run", 5, "method", "\\App\\Http\\Caller")]],
    [ENTITY, [sym(ENTITY, "Entity", 3, "class", NS), sym(ENTITY, "boot", 5, "method", `${NS}Entity`)]],
    [MODEL, [
      sym(MODEL, "Model", 3, "class", NS, { phpExtends: `${NS}Entity` }),
      sym(MODEL, "create", 5, "method", `${NS}Model`),
      sym(MODEL, "tag", 9, "method", `${NS}Model`),
    ]],
    [USER, [sym(USER, "User", 3, "class", NS, { phpExtends: `${NS}Model` })]],
    [POST, [
      sym(POST, "Post", 3, "class", NS, { phpExtends: `${NS}Model`, phpTraits: [`${NS}HasTag`, `${NS}HasSlug`] }),
      sym(POST, "create", 5, "method", `${NS}Post`),
    ]],
    [TRAITS, [
      sym(TRAITS, "HasTag", 3, "trait", NS, { phpTraits: [`${NS}Nested`] }),
      sym(TRAITS, "tag", 5, "method", `${NS}HasTag`),
      sym(TRAITS, "HasSlug", 10, "trait", NS),
      sym(TRAITS, "tag", 12, "method", `${NS}HasSlug`),
      sym(TRAITS, "Nested", 17, "trait", NS),
      sym(TRAITS, "deep", 19, "method", `${NS}Nested`),
    ]],
    [LOOP, [
      sym(LOOP, "Ping", 3, "class", NS, { phpExtends: `${NS}Pong` }),
      sym(LOOP, "Pong", 8, "class", NS, { phpExtends: `${NS}Ping` }),
    ]],
    [OTHER, [
      sym(OTHER, "Other", 3, "class", "\\App\\Other\\", { phpExtends: "\\Vendor\\Model" }),
      sym(OTHER, "Unrelated", 8, "class", "\\App\\Other\\"),
      sym(OTHER, "find", 10, "method", "\\App\\Other\\Unrelated"),
    ]],
    // One class name in two packages of the same repository, neither in the
    // caller's reach. Only one inherits a `create`.
    [TWIN_A, [sym(TWIN_A, "Twin", 3, "class", NS, { phpExtends: `${NS}Model` })]],
    [TWIN_B, [sym(TWIN_B, "Twin", 3, "class", NS)]],
  ]);

  const resolve = (calleeName: string, calleeQualifier: string): SymbolEdge => {
    const edge: SymbolEdge = {
      callerId: `${CALLER}::run#5`,
      calleeName,
      calleeCandidates: [],
      confidence: "unresolved",
      kind: "call",
      calleeQualifier,
      callSite: { file: CALLER, line: 6 },
    };
    resolveCallSites(graph, symbols(), new Map([[CALLER, [edge]]]));
    return edge;
  };

  it("resolves a method the class inherits to the parent that declares it", () => {
    const edge = resolve("create", `${NS}User`);
    expect(edge.calleeCandidates).toEqual([`${MODEL}::create#5`]);
    expect(edge.confidence).toBe("unique");
  });

  it("follows the chain past the parent", () => {
    expect(resolve("boot", `${NS}User`).calleeCandidates).toEqual([`${ENTITY}::boot#5`]);
  });

  it("answers with the class's own method before an inherited one", () => {
    expect(resolve("create", `${NS}Post`).calleeCandidates).toEqual([`${POST}::create#5`]);
  });

  it("takes a trait's method over the parent's, and returns both when two traits declare it", () => {
    // `Model::tag()` is inherited too, but a trait's method overrides it. Which
    // of the two traits PHP runs rests on an `insteadof` the index does not read.
    const edge = resolve("tag", `${NS}Post`);
    expect(edge.calleeCandidates).toEqual([`${TRAITS}::tag#5`, `${TRAITS}::tag#12`]);
    expect(edge.confidence).toBe("multiple-candidates");
  });

  it("follows a trait's own traits", () => {
    expect(resolve("deep", `${NS}Post`).calleeCandidates).toEqual([`${TRAITS}::deep#19`]);
  });

  it("stops at a parent the project does not declare", () => {
    // `Other` extends `\Vendor\Model`, not `App\Models\Model`, whose `create`
    // is right there in the index.
    const edge = resolve("create", "\\App\\Other\\Other");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("does not walk from a class the project does not declare", () => {
    expect(resolve("create", `${NS}Missing`).confidence).toBe("unresolved");
  });

  it("leaves a method no ancestor declares unresolved, though an unrelated class declares it", () => {
    const edge = resolve("find", `${NS}User`);
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("does not follow inheritance from a class declared twice at the same reach", () => {
    // Which `Twin` the call means is not known, and only one of them inherits
    // `Model::create()`, so answering with it would be a guess.
    const edge = resolve("create", `${NS}Twin`);
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("ends on an inheritance cycle", () => {
    expect(resolve("missing", `${NS}Ping`).confidence).toBe("unresolved");
  });
});
