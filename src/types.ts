// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
export interface FileChunk {
  id: string;
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  type: "code" | "comment" | "mixed";
}

export interface CodeGraphNode {
  filePath: string;
  relativePath: string;
  /**
   * Language label for display/stats, set at graph-build time. For extensionless
   * files this carries the content-detected language, which the path alone cannot
   * yield. Absent on nodes from older persisted graphs, on grammar-less
   * extra-extension nodes, and on import-target-only nodes that discovery never
   * content-detected; consumers fall back to path-based derivation via
   * nodeLanguage().
   */
  language?: string;
  imports: string[];
  exports: string[];
  dependencies: string[];
  dependents: string[];
}

export interface CodeGraphEdge {
  source: string;
  target: string;
  type: "import" | "re-export" | "dynamic-import";
}

export interface CodeGraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
}

export interface SearchResult {
  filePath: string;
  relativePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  score: number;
  /** Source project label (set when searching across multiple collections) */
  project?: string;
  /**
   * Cosine similarity of this chunk against the query vector, when the caller
   * asked for it. `score` from a hybrid query is a Reciprocal Rank Fusion value
   * derived from ranks *within one collection*, so it says nothing comparable
   * across collections: an irrelevant top hit in a small project and a perfect
   * match in a large one both land near the same number. Cosine is an absolute
   * measure against the same query vector, so it is the one figure that can
   * order results from different collections against each other.
   */
  denseScore?: number;
}

export interface HealthStatus {
  docker: boolean;
  ollama: boolean;
  qdrant: boolean;
  ollamaModel: boolean;
  qdrantImage: boolean;
  ollamaImage: boolean;
}

/** A context artifact defined in .socraticodecontextartifacts.json */
export interface ContextArtifact {
  /** Unique name for this artifact (e.g. "database-schema") */
  name: string;
  /** Path to the file or directory (relative to project root or absolute) */
  path: string;
  /** Human-readable description explaining what this artifact is and how the AI should use it */
  description: string;
}

/** Runtime state of an indexed artifact */
export interface ArtifactIndexState {
  name: string;
  description: string;
  /** Resolved absolute path */
  resolvedPath: string;
  /** Hash of the artifact path and description settings used for this index. */
  configurationSignature?: string;
  /** Content hash at the time of last indexing */
  contentHash: string;
  /** ISO timestamp of last indexing */
  lastIndexedAt: string;
  /** Number of chunks stored */
  chunksIndexed: number;
}

// ── Symbol-level call graph (Impact Analysis) ────────────────────────────

/** Kinds of symbols extracted from source code */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "constructor"
  | "interface"
  | "trait"
  | "enum"
  | "module"
  | "struct"
  | "type"
  | "variable"
  | "signal"
  | "constant";

/** A single symbol (definition) extracted from source code */
export interface SymbolNode {
  /** Stable id: `${relativePath}::${qualifiedName}#${line}` */
  id: string;
  /** Unqualified name (e.g. "validateUser") */
  name: string;
  /** Qualified name (e.g. "Auth.validateUser") when nested in a class/module */
  qualifiedName: string;
  kind: SymbolKind;
  /** Relative path */
  file: string;
  /** 1-based line number of the definition start */
  line: number;
  /** 1-based line number of the definition end */
  endLine: number;
  /** Re-export alias, if any */
  exportedAs?: string;
  /** Whether the symbol is exported from its containing module */
  isExported?: boolean;
  language: string;
  /** Type annotation for typed variables (GDScript `var x: Fighter`).
   *  Used by receiver-type resolution to resolve `x.method()` → `Fighter.method()`. */
  typeName?: string;
  /** True only for a GDScript `class_name` declaration, never an inner class. */
  isGdscriptClassName?: boolean;
  /**
   * PHP only: the fully qualified name of what declares this symbol, which a
   * qualified PHP edge's `calleeQualifier` is matched against.
   *
   * A method's owner is its class, interface, trait or enum, written as that
   * class's name: `\App\Models\Invoice`. A class, interface or trait is owned
   * by its namespace, written as a namespace prefix with the trailing `\` PHP
   * itself uses for one: `\App\Models\`, and `\` for the global namespace. The
   * two forms cannot collide, so a qualifier naming a class answers only its
   * methods and one naming a namespace only its classes.
   *
   * Absent for every other language, for a method of an anonymous class —
   * which no qualified name can reach — for an `abstract` method, which no
   * call runs, and for every graph persisted before it existed. The symbol's
   * `id` and `qualifiedName` are unchanged by it.
   */
  phpOwner?: string;
  /**
   * PHP classes only: the class this one `extends`, as a fully qualified class
   * name in the form {@link phpOwner} uses for one (`\App\Models\Model`).
   * Resolution follows it when a static call names this class and the class
   * does not declare the method itself. Absent when the class extends nothing,
   * or names its parent in a way the extractor cannot read statically.
   */
  phpExtends?: string;
  /**
   * PHP classes and traits only: the traits this one `use`s in its body, as
   * fully qualified class names, in the order they are written. Followed
   * before {@link phpExtends}, since a trait's method overrides an inherited
   * one. Absent when there are none.
   */
  phpTraits?: string[];
  /**
   * C# only: the declaration's name with its namespace and every enclosing
   * type, as C# itself writes the full name: `App.Billing.Calc` for a class,
   * `App.Billing.Calc.Compute` for its method, `App.Billing.Calc.Inner` for a
   * nested type. A qualified C# edge (`Billing.Calc.Compute()`, a parameter of
   * type `Billing.Calc`) is matched against its trailing segments, so a
   * namespace the call writes out is never answered by a same-named type in
   * another one. Absent for every other language and for every graph
   * persisted before it existed, where resolution reads `qualifiedName`
   * instead. The symbol's `id` and `qualifiedName` are unchanged by it.
   */
  csFullName?: string;
  /**
   * C# types only: the fields, constants, events and enum members the type
   * declares, which are not recorded as symbols of their own. Resolution reads
   * them as evidence that a member-access receiver ends in a static member —
   * `Open` in `OrderState.Open.Id` — rather than in a namespace segment.
   * Absent when the type declares none, and on every graph persisted before it
   * existed.
   */
  csMembers?: string[];
  /**
   * C# types only: the base class and interfaces as the declaration writes
   * them, type arguments dropped and the file's `using` aliases written out
   * (`App.Data.Repository`, `IFoo`). Resolution looks each one up as C# does —
   * the enclosing types and namespaces, innermost first, then the namespaces
   * its file imports — and follows it to find a member the type inherits from
   * another project type. Absent when the type names no base, and on every
   * graph persisted before it existed.
   */
  csBases?: string[];
  /**
   * C# `<module>` symbols only: the namespaces the file imports with a
   * file-level `using`, and the types it imports with `using static` (whose
   * nested types become visible by name), its own `global using`s included,
   * aliases excluded. A type name the enclosing scopes do not declare is
   * looked for under them. Absent when the file imports none. A `global using`
   * is not applied to any other file: which files one compilation shares is
   * set by the project system, which the graph does not read, so a type
   * imported only through another file's `global using` (a `GlobalUsings.cs`,
   * or a `<Using Include>` item in a `.csproj`) stays unresolved.
   */
  csUsings?: string[];
  /**
   * C# `<module>` symbols only: the imports declared inside a namespace block,
   * with the block's lines. They apply to references within those lines only,
   * so a sibling block's imports never reach them. Absent when no block has any.
   */
  csScopedUsings?: Array<{ line: number; endLine: number; usings: string[] }>;
}

/** Kind of relationship an edge represents */
export type EdgeKind =
  | "call"
  | "value_reference"
  | "type_reference"
  | "import"
  | "reexport";

/** Confidence level for a resolved call edge */
export type SymbolEdgeConfidence =
  | "local"
  | "unique"
  | "multiple-candidates"
  | "unresolved"
  // Not a project symbol, excluded from unresolved %: a Godot engine API call,
  // or a .NET framework type (`Task`, `List`) that no C# file of the project declares.
  | "engine";

/** A call-site edge between symbols */
export interface SymbolEdge {
  /** SymbolNode.id of the caller */
  callerId: string;
  /** Raw name at the call site (e.g. "foo" in "foo()") */
  calleeName: string;
  /** Resolved SymbolNode.ids: 0 = external, 1 = unique, >1 = ambiguous */
  calleeCandidates: string[];
  confidence: SymbolEdgeConfidence;
  kind: EdgeKind;
  /** Source module specifier from import statement (e.g. "./utils") */
  sourceModule?: string;
  /** Original imported or exported name in the source module */
  importedName?: string;
  /**
   * Local binding alias in the caller file for import edges (e.g. `localFoo` in `import { foo as localFoo }`),
   * or the exported alias for re-export edges (e.g. `Y` in `export { X as Y }` or `export * as Y from './mod'`).
   */
  localAlias?: string;
  /**
   * The path qualifying the callee at the call site, terminal name excluded:
   * `Vec` in `Vec::new()`, `std::fs` in `std::fs::copy()`. Absent on a bare
   * call, and absent from every graph persisted before it existed — resolution
   * treats an edge without one exactly as it always did.
   *
   * It is kept because the name alone cannot be resolved safely: `new` names
   * 191 symbols on tokio, so a qualified call matched by name would either
   * pick one arbitrarily or list them all. With the qualifier, resolution can
   * narrow to the scope the call actually names, or say it could not.
   *
   * PHP writes it already resolved under the file's namespace and `use`
   * imports, in the two forms {@link SymbolNode.phpOwner} uses: the class a
   * static call names (`\App\Models\Invoice` for `Invoice::capture()`), or the
   * namespace a class reference names (`\App\Models\` for `extends Invoice`,
   * a type hint or `new Invoice()`). Absent on every PHP call it cannot
   * qualify statically — `$obj->m()`, `$class::m()`, `Cls::$m()`, `self::`,
   * `static::`, `parent::` and bare function calls.
   *
   * C# writes it as the call site spells it, dots kept, type arguments
   * dropped and the file's `using` alias in scope written out:
   * `Billing.Calc` for `Billing.Calc.Compute()`, `global::Billing.Calc` when
   * the source anchors it. A receiver that is a variable (`repo.Save()`) is
   * kept too, so the call is never answered by its bare name; no type matches
   * it, and the edge stays unresolved. An object creation
   * `new Billing.Calc()` carries the whole type path, `Billing.Calc`, with
   * `Calc` as the callee — a member cannot share its class's name in C#, so
   * the repeated name marks a constructor call without ambiguity.
   */
  calleeQualifier?: string;
  /**
   * C# `type_reference` edges only: the edge names the receiver of a member
   * access (`Config.Instance` in `Config.Instance.Load()`), whose last segments
   * may be static members rather than types — an expression does not say
   * which. Resolution tries the longest prefix of the written path that names
   * a project type first (`Config.Instance`, then `Config`). Absent on a type
   * position, where the whole path is the type, and on every graph persisted
   * before it existed.
   */
  csMemberReceiver?: boolean;
  callSite: { file: string; line: number };
  /** Receiver expression for method calls (e.g. "fighter" in "fighter.take_damage()").
   *  Used by GDScript receiver-type resolution. Absent for bare function calls.
   *  C# sets it only where the receiver is no name path: `this`, `base`, or `?`
   *  for any other expression (a call result, `a?.b`, an element access) —
   *  such a call is answered from the caller's own type or its bases, or not at all. */
  receiver?: string;
  /** True when a GDScript call edge represents `signal_name.emit()`.
   *  Optional so symbol graphs built before signal-edge support remain readable. */
  signalEmit?: boolean;
}

/** Lightweight reference to a symbol (used by name index) */
export interface SymbolRef {
  /** Relative file path containing the symbol */
  file: string;
  /** SymbolNode.id */
  id: string;
}

/** Top-level metadata for a project's symbol graph */
export interface SymbolGraphMeta {
  projectId: string;
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  unresolvedEdgePct: number;
  builtAt: number;
  schemaVersion: 1 | 2;
  generation?: string;
}

/** Per-file payload stored in `_symgraph_file` */
export interface SymbolGraphFilePayload {
  /** Relative path */
  file: string;
  language: string;
  /** SHA-256 of source bytes for staleness detection */
  contentHash: string;
  symbols: SymbolNode[];
  /** Edges whose caller is in this file */
  outgoingCalls: SymbolEdge[];
}

/** Detected entry point with reason */
export interface EntryPoint {
  /** SymbolNode.id, or relative file path for orphan-file entries */
  id: string;
  /** Display name */
  name: string;
  file: string;
  line?: number;
  /** Reason categorisation (e.g. "orphan", "well-known-name:main", "framework:express-get") */
  reason: string;
}
