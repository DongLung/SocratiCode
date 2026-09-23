// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractSymbolsAndCalls } from "../../src/services/graph-symbols.js";

/**
 * PHP structural type references.
 *
 * `extractFromPhp` used to read three node kinds, all of them calls, so a
 * class reached only through `extends`, `implements`, a trait `use`, `new` or
 * a type hint produced no symbol edge at all. File-mode `codebase_impact`
 * derives its reverse index from resolved symbol edges, so a base class every
 * subclass names reported no dependents, while `codebase_graph_query` — which
 * reads the file-import graph instead — listed them.
 */
describe("PHP structural type-reference extraction", () => {
  // PHP is a dynamically-registered ast-grep grammar. Without this the parse
  // throws, `safeFindAll` swallows it, and every assertion below sees an empty
  // list — a silent pass-by-vacuum rather than a failure.
  beforeAll(() => ensureDynamicLanguages());

  interface Ref {
    calleeName: string;
    kind: string;
    localAlias?: string;
  }

  const refsIn = (php: string): Ref[] => {
    // Signature is (source, lang, ext, relativePath). Passing the path as
    // `lang` silently routes to a fallback that extracts nothing structural,
    // so a wrong-arity call here would pass while testing nothing.
    const { rawCalls } = extractSymbolsAndCalls(php, "php", ".php", "t.php");
    return rawCalls.map((c) => ({
      calleeName: c.calleeName,
      kind: c.kind,
      ...(c.localAlias === undefined ? {} : { localAlias: c.localAlias }),
    }));
  };

  const namesOf = (php: string, kind = "type_reference"): string[] =>
    refsIn(php)
      .filter((r) => r.kind === kind)
      .map((r) => r.calleeName);

  it("records a class's parent from `extends`", () => {
    expect(namesOf("<?php\nclass Child extends Base {}\n")).toEqual(["Base"]);
  });

  it("records every parent of an interface, which reuses the same clause", () => {
    // `interface I extends J, K` is a `base_clause` too, with two names in it —
    // reading only the first would lose every interface past the head.
    expect(namesOf("<?php\ninterface Iface extends ParentA, ParentB {}\n"))
      .toEqual(["ParentA", "ParentB"]);
  });

  it("records every interface in an `implements` list", () => {
    expect(namesOf("<?php\nclass C extends Base implements Iface, Countable {}\n"))
      .toEqual(["Base", "Iface", "Countable"]);
  });

  it("records a trait `use`, including a comma-separated list", () => {
    expect(namesOf("<?php\nclass C {\n    use TraitA;\n    use TraitB, TraitC;\n}\n"))
      .toEqual(["TraitA", "TraitB", "TraitC"]);
  });

  it("reads a trait's name past its alias block without reading the aliases", () => {
    // `use T { foo as bar; }` files the aliases under a nested `use_list`, so
    // reading descendants rather than direct children would emit `foo`/`bar`.
    expect(namesOf("<?php\nclass C {\n    use TraitC { foo as bar; }\n}\n"))
      .toEqual(["TraitC"]);
  });

  it("does not mistake a closure's `use ($x)` for a trait `use`", () => {
    // A different grammar node (`anonymous_function_use_clause`), and one that
    // names variables, not types.
    expect(refsIn("<?php\n$f = function ($a) use ($b) { return $b; };\n")).toEqual([]);
  });

  it("records `new Foo()` as a call, matching how `new` is treated elsewhere", () => {
    // The TypeScript extractor records `new_expression` beside
    // `call_expression` as kind "call"; PHP follows that precedent.
    expect(refsIn("<?php\nfunction f() { return new Foo(); }\n"))
      .toEqual([{ calleeName: "Foo", kind: "call" }]);
  });

  it("records a parameter type hint", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(Base $b) {}\n}\n"))
      .toEqual(["Base"]);
  });

  it("records a variadic parameter's type and attributes it to its method or function", () => {
    // `Handler ...$handlers` is a `variadic_parameter`, not a
    // `simple_parameter`, so a scan naming only the plain kind dropped the one
    // parameter that takes a list of collaborators. The by-reference nullable
    // form puts `&` and `...` between the type and the name as well.
    const { symbols, rawCalls } = extractSymbolsAndCalls(
      "<?php\nclass C {\n    public function go(Handler ...$handlers) {}\n}\n"
        + "function run(?Middleware &...$stack) {}\n",
      "php", ".php", "t.php",
    );
    const go = symbols.find((s) => s.name === "go");
    const run = symbols.find((s) => s.name === "run");
    expect(go && run).toBeTruthy();
    expect(rawCalls
      .filter((c) => c.kind === "type_reference")
      .map((c) => ({ calleeName: c.calleeName, callerId: c.callerId })))
      .toEqual([
        { calleeName: "Handler", callerId: go?.id },
        { calleeName: "Middleware", callerId: run?.id },
      ]);
    // A closure's and an arrow function's parameters are reached by the same
    // scan, variadic ones included.
    expect(namesOf("<?php\n$a = function (Widget ...$w) {};\n$b = fn (Gadget ...$g) => null;\n"))
      .toEqual(["Widget", "Gadget"]);
  });

  it("records a return type hint", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(): Base {}\n}\n"))
      .toEqual(["Base"]);
  });

  it("records a closure's return type", () => {
    // A closure's parameters were already reached by the parameter scan, so
    // before this a collaborator named only in the return position was
    // invisible on a closure while visible on the same signature written as a
    // named function.
    expect(namesOf("<?php\n$f = function (): Widget {};\n")).toEqual(["Widget"]);
  });

  it("records an arrow function's return type", () => {
    expect(namesOf("<?php\n$f = fn (): Gadget => null;\n")).toEqual(["Gadget"]);
  });

  it("records a static closure's and a static arrow function's return types", () => {
    expect(namesOf("<?php\n$a = static function (): Widget {};\n$b = static fn (): Gadget => null;\n"))
      .toEqual(["Widget", "Gadget"]);
  });

  it("unwraps a closure's nullable and an arrow function's union return type", () => {
    expect(namesOf("<?php\n$a = function (): ?Widget {};\n$b = fn (): Alpha|Beta => null;\n"))
      .toEqual(["Widget", "Alpha", "Beta"]);
  });

  it("registers no symbol for an anonymous function", () => {
    // Collected apart from the declaration loop for this reason: that loop
    // files a symbol per node, and `safeFind(fn, "name")` on an anonymous
    // function would return the first `name` in its body.
    const { symbols } = extractSymbolsAndCalls(
      "<?php\n$f = function (): Widget { return helper(); };\n",
      "php",
      ".php",
      "t.php",
    );
    expect(symbols.map((s) => s.name)).toEqual(["<module>"]);
  });

  it("records a constructor-promoted property's type", () => {
    // A promoted property is a parameter in the signature, and constructor
    // injection is where most modern PHP names its collaborators.
    expect(namesOf("<?php\nclass C {\n    public function __construct(private readonly Repo $r) {}\n}\n"))
      .toEqual(["Repo"]);
  });

  it("records a longhand typed property's type", () => {
    // The same collaborator as the promoted form above, written out. Reading
    // only the promoted one made the edge depend on the spelling.
    expect(namesOf("<?php\nclass P {\n    private ?PersonRecord $rec = null;\n}\n"))
      .toEqual(["PersonRecord"]);
  });

  it("records every member of a union-typed property", () => {
    expect(namesOf("<?php\nclass P {\n    public Alpha|Beta $either;\n}\n"))
      .toEqual(["Alpha", "Beta"]);
  });

  it("emits nothing for a primitive-typed property", () => {
    const php = `<?php
class P {
    public int $n = 0;
    protected static string $s = '';
    public readonly ?bool $flag;
}`;
    expect(refsIn(php)).toEqual([]);
  });

  it("unwraps a nullable type", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(?Base $b): ?Other {}\n}\n"))
      .toEqual(["Base", "Other"]);
  });

  it("records every member of a union type", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(Alpha|Beta $x) {}\n}\n"))
      .toEqual(["Alpha", "Beta"]);
  });

  it("records every member of an intersection type", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(LoggerInterface&Stringable $x) {}\n}\n"))
      .toEqual(["LoggerInterface", "Stringable"]);
  });

  it("records the class names inside a disjunctive normal form type", () => {
    // PHP 8.2 `(A&B)|null` — a wrapper around a wrapper, and `null` is a
    // primitive that must not come through with them.
    expect(namesOf("<?php\nclass C {\n    public function go((A&B)|null $x) {}\n}\n"))
      .toEqual(["A", "B"]);
  });

  it("maps an aliased `use` back to the name the target declares", () => {
    // The edge must name `Base`, which is what `Base.php` declares — the file
    // holds no symbol called `Ancestor`, so emitting the local spelling would
    // resolve to nothing.
    expect(refsIn("<?php\nuse App\\Base\\Base as Ancestor;\nclass X extends Ancestor {}\n"))
      .toEqual([{ calleeName: "Base", kind: "type_reference", localAlias: "Ancestor" }]);
  });

  it("maps an alias from a grouped `use` too", () => {
    expect(refsIn("<?php\nuse App\\Grp\\{Alpha, Beta as Gamma};\nclass X extends Gamma {}\n"))
      .toEqual([{ calleeName: "Beta", kind: "type_reference", localAlias: "Gamma" }]);
  });

  it("leaves an unaliased `use` with no local alias", () => {
    expect(refsIn("<?php\nuse App\\Base\\Base;\nclass X extends Base {}\n"))
      .toEqual([{ calleeName: "Base", kind: "type_reference" }]);
  });

  it("does not let a `use function` alias answer a type reference", () => {
    // `use function App\Fn\Base as Thing` imports a function; a class called
    // `Thing` is a different thing entirely, so the edge keeps its own name.
    expect(refsIn("<?php\nuse function App\\Fn\\Base as Thing;\nclass X extends Thing {}\n"))
      .toEqual([{ calleeName: "Thing", kind: "type_reference" }]);
  });

  it("does not let a grouped `use function` alias answer a type reference", () => {
    // The grouped form puts `function` on the DECLARATION, not on the clause,
    // so a per-clause check alone read this as a type import and rewrote the
    // parent to `Base`. PHP disagrees: the same file fatals with
    // `Class "Main\Thing" not found`.
    expect(refsIn("<?php\nuse function App\\Fn\\{Base as Thing};\nclass X extends Thing {}\n"))
      .toEqual([{ calleeName: "Thing", kind: "type_reference" }]);
  });

  it("does not let a grouped `use const` alias answer a type reference", () => {
    expect(refsIn("<?php\nuse const App\\C\\{Base as Thing};\nclass X extends Thing {}\n"))
      .toEqual([{ calleeName: "Thing", kind: "type_reference" }]);
  });

  it("applies a mixed group's type member while rejecting its function member", () => {
    // `use A\{B, function c};` qualifies each member individually, so the
    // declaration carries no keyword and only the per-clause check can tell
    // the two apart. Positive control for the declaration-level check: it
    // must not reject the whole group.
    const php = "<?php\nuse App\\{Base, function helper};\nclass X extends Base {}\nclass Y extends helper {}\n";
    expect(refsIn(php)).toEqual([
      { calleeName: "Base", kind: "type_reference" },
      { calleeName: "helper", kind: "type_reference" },
    ]);
  });

  it("names a leading-backslash FQCN by its terminal segment", () => {
    // Symbols are indexed under the short name they were declared with, so
    // only the last segment can ever match one.
    expect(namesOf("<?php\nclass X extends \\App\\Base\\Base {}\n")).toEqual(["Base"]);
  });

  it("does not let a `use` alias answer a fully-qualified single-segment name", () => {
    // `\Foo` is rooted at the global namespace, and stripping the slash makes
    // it indistinguishable from the bare `Foo` a `use` may alias. PHP reads
    // the two oppositely: under `use X\Other as Foo;`, `extends Foo` resolves
    // to `X\Other` while `extends \Foo` fatals with `Class "Foo" not found`.
    expect(refsIn("<?php\nuse X\\Other as Foo;\nclass C extends \\Foo {}\n"))
      .toEqual([{ calleeName: "Foo", kind: "type_reference" }]);
  });

  it("does not let a `use` alias answer a fully-qualified name in a `new`", () => {
    expect(refsIn("<?php\nuse X\\Other as Foo;\nfunction f() { return new \\Foo(); }\n"))
      .toEqual([{ calleeName: "Foo", kind: "call" }]);
  });

  it("still applies the alias to the same name written bare", () => {
    // Positive control for the two above: the slash is the whole difference,
    // and the runtime resolves this one to `X\Other`.
    expect(refsIn("<?php\nuse X\\Other as Foo;\nclass C extends Foo {}\n"))
      .toEqual([{ calleeName: "Other", kind: "type_reference", localAlias: "Foo" }]);
  });

  it("names a namespace-relative path by its terminal segment", () => {
    expect(namesOf("<?php\nclass X extends Base\\Inner {}\n")).toEqual(["Inner"]);
  });

  it("names an FQCN in a `new` by its terminal segment", () => {
    expect(refsIn("<?php\nfunction f() { return new \\App\\Full\\Qualified(); }\n"))
      .toEqual([{ calleeName: "Qualified", kind: "call" }]);
  });

  it("names a class whose identifier is not ASCII", () => {
    // PHP admits any non-ASCII character in a name, and the grammar parses
    // `Café`, `Документ` and `文書` alike as a `name`. An ASCII-only guard
    // dropped each of these edges without a word.
    expect(namesOf("<?php\nclass A extends Café {}\nclass B extends Документ {}\nclass C extends 文書 {}\n"))
      .toEqual(["Café", "Документ", "文書"]);
  });

  it("names a non-ASCII class in every structural position, and by its terminal segment", () => {
    const php = `<?php
class C extends Базовый implements 可比较 {
    private ?Журнал $log = null;
    public function go(Документ $d): \\App\\Модель\\文書 { return new Отчет(); }
}`;
    expect(namesOf(php)).toEqual(["Базовый", "可比较", "Документ", "Журнал", "文書"]);
    expect(namesOf(php, "call")).toEqual(["Отчет"]);
  });

  it("emits nothing for `self`, `parent` and `static`", () => {
    const php = `<?php
class C {
    public function a(self $s, parent $p): static {}
    public function b() { return new static(); }
    public function c() { return new self(); }
}`;
    expect(refsIn(php)).toEqual([]);
  });

  it("emits nothing for primitive and built-in type names", () => {
    const php = `<?php
class C {
    public function a(int $i, string $s, bool $b, array $a, ?float $f): void {}
    public function b(mixed $m, iterable $it, callable $c, object $o): never {}
}`;
    expect(refsIn(php)).toEqual([]);
  });

  it("filters a built-in written in another case, PHP type names being case-insensitive", () => {
    expect(refsIn("<?php\nclass C {\n    public function a(Array $a, INT $i): VOID {}\n}\n"))
      .toEqual([]);
  });

  it("keeps `integer`, `double` and `boolean`, which PHP reads as class names", () => {
    // These read like type keywords and are not. PHP warns
    // `"integer" will be interpreted as a class name. Did you mean "int"?`
    // and then resolves it as a class, so filtering them dropped a real
    // reference from any project that declares one.
    expect(namesOf("<?php\nclass C {\n    public function a(integer $a, double $b, boolean $c) {}\n}\n"))
      .toEqual(["integer", "double", "boolean"]);
  });

  it("matches a `use` alias case-insensitively, as PHP resolves class names", () => {
    // `use X\Base as ImportedBase; class C extends importedbase {}` resolves
    // the parent to `X\Base` under the runtime. A case-sensitive table emitted
    // `importedbase`, which names no declared symbol. The edge carries the
    // imported spelling and keeps the local one as written.
    expect(refsIn("<?php\nuse X\\Base as ImportedBase;\nclass C extends importedbase {}\n"))
      .toEqual([{ calleeName: "Base", kind: "type_reference", localAlias: "importedbase" }]);
  });

  it("matches an unaliased `use` case-insensitively too", () => {
    expect(refsIn("<?php\nuse X\\Base;\nclass C extends BASE {}\n"))
      .toEqual([{ calleeName: "Base", kind: "type_reference", localAlias: "BASE" }]);
  });

  it("folds alias case over ASCII only, as PHP does", () => {
    // PHP's fold is ASCII-only: `class É {}` then `new é()` fails with
    // `Class "é" not found`, while `Widget` and `WIDGET` are one class. A
    // Unicode-aware fold is not merely stricter, it is wrong in a direction
    // that invents edges — `"\u212a"` (KELVIN SIGN) lowercases to ASCII `k`,
    // so `Kelvin` spelled with it would answer a reference to a plain
    // `kelvin` that PHP considers an unrelated name.
    const php = "<?php\nuse X\\Base as \u212aelvin;\nclass C extends kelvin {}\n";
    expect(refsIn(php)).toEqual([{ calleeName: "kelvin", kind: "type_reference" }]);
  });

  it("emits nothing for a name the parse split at a character past the BMP", () => {
    // The grammar's `name` token stops at the BMP, so each of these arrives as
    // part of the written name with an `ERROR` fragment beside it: `野` before
    // the fragment, `Doc` after it. Emitting either would name a class the
    // source never writes, and a reachable class of that name would answer it.
    const php = `<?php
class A extends 野𠮷 {}
class B extends 𠮷Doc {}
class C implements 可比较𠮷 {}
function f() { return new 野𠮷(); }
function g(𠮷Doc $d): 野𠮷 {}
`;
    expect(refsIn(php)).toEqual([]);
  });

  it("suppresses a split name whose surviving part is ASCII, as the grammar cuts there too", () => {
    // `main` recorded `B` here. It is the same partial name, and the same
    // wrong parent if a class `B` is reachable.
    expect(refsIn("<?php\nclass A extends B𝑓 {}\n")).toEqual([]);
  });

  it("emits nothing for a qualified name the parse split, not the namespace it opens with", () => {
    // A qualified name loses more than the segment that was cut. The parse
    // gives up at the cut and hands back only the part before it, so
    // `App\野𠮷` arrives as the bare `App` — which is not a shortened class
    // name but a namespace head, and one a great many projects also declare a
    // class under. Every node kind `extractFromPhp` collects a qualified name
    // from is spelled out below — they all reach the guard through the same
    // `pushTypeRef`, but an enumeration is what proves none was missed.
    const php = `<?php
class A extends App\\野𠮷 {}
class B implements App\\野𠮷 {}
class C { use App\\野𠮷; }
class D { private App\\野𠮷 $r; }
class E { public function __construct(private App\\野𠮷 $r) {} }
function f(App\\野𠮷 $x): A\\B\\C\\野𠮷 {}
function g() { return new \\App\\野𠮷(); }
function h(App\\野𠮷 ...$v) {}
$k = fn (): App\\野𠮷 => 1;
class F extends App\\𠮷Doc {}
`;
    expect(refsIn(php)).toEqual([]);
  });

  it("still records the whole name when nothing is split off it", () => {
    // The guard keys on an identifier character or a `\` touching the node,
    // which a name the parse read whole never has: the `name` token takes the
    // longest run it can, and a whole qualified name is one node with its
    // separators inside it. Positive control for the tests above.
    expect(namesOf("<?php\nclass A extends 野 {}\nclass B extends Doc {}\nclass C extends Café {}\n"))
      .toEqual(["野", "Doc", "Café"]);
    expect(namesOf("<?php\nclass A extends App\\Model\\Doc {}\nclass B extends \\App\\野 {}\n"))
      .toEqual(["Doc", "野"]);
  });

  it("keeps a rooted name written tight against the `new` before it", () => {
    // `new\App\Made()` is valid — PHP ends the keyword at the `\`, which is
    // not an identifier character. A guard that asked only whether an
    // identifier character touches the node would read the `w` of `new` as the
    // name running on and drop an edge the parse got exactly right, so the
    // left edge requires identifier characters meeting on both sides of the
    // boundary. `extends\App\Foo` and the same tightening on `implements` and
    // a trait `use` are *not* valid — PHP 8 lexes `extends\App\Foo` as one
    // namespaced name — so `new` is the only spelling this can be tested on.
    expect(refsIn("<?php\nfunction f() { return new\\App\\Made(); }\n"))
      .toEqual([{ calleeName: "Made", kind: "call" }]);
  });

  it("keeps a rooted name whose own first character is past the BMP", () => {
    // `\𠮷Doc` is valid PHP, and although the parse errors inside it, the
    // `qualified_name` wrapper spans the `ERROR` fragment — so the node's text
    // is the whole written name, nothing is split off *it*, and the reference
    // stands. It names what the source writes; that no declaration can answer
    // it is the parse's BMP limit on the other side, not a name this guard
    // should invent or suppress.
    expect(namesOf("<?php\nclass G extends \\𠮷Doc {}\n")).toEqual(["𠮷Doc"]);
  });

  it("maps a non-ASCII alias through the same ASCII-only fold", () => {
    // `ÄRGER` folds to `Ärger` and names the import; `ärger` differs in a
    // non-ASCII letter, which PHP does not fold, so it names another class.
    // Escaped so the source holds the precomposed letters: decomposed, `Ä` is
    // an ASCII `A` plus a combining mark, and the ASCII fold would reach it.
    const php = "<?php\nuse X\\Base as \u00c4rger;\nclass A extends \u00c4RGER {}\nclass B extends \u00e4rger {}\n";
    expect(refsIn(php)).toEqual([
      { calleeName: "Base", kind: "type_reference", localAlias: "\u00c4RGER" },
      { calleeName: "\u00e4rger", kind: "type_reference" },
    ]);
  });

  it("attributes `extends` to the class and a type hint to the method", () => {
    // `findCallerId` takes the innermost scope containing the line, so the two
    // edges must not share a caller — that is what makes symbol-mode impact
    // point at the subclass rather than at the file.
    const { symbols, rawCalls } = extractSymbolsAndCalls(
      "<?php\nclass Child extends Base {\n    public function go(Other $o) {}\n}\n",
      "php", ".php", "t.php",
    );
    const child = symbols.find((s) => s.name === "Child");
    const go = symbols.find((s) => s.name === "go");
    expect(child && go).toBeTruthy();
    expect(rawCalls.find((c) => c.calleeName === "Base")?.callerId).toBe(child?.id);
    expect(rawCalls.find((c) => c.calleeName === "Other")?.callerId).toBe(go?.id);
  });

  it("collapses one class named twice in the same signature into one edge", () => {
    // Parameter and return type of the same method are the same edge, as the
    // TypeScript extractor's dedupe treats them.
    expect(namesOf("<?php\nclass C {\n    public function go(Base $b): Base {}\n}\n"))
      .toEqual(["Base"]);
  });

  it("keeps the same class in two different methods as two edges", () => {
    // The dedupe key carries the caller, so narrowing it to the name alone
    // would silently drop the second method's dependency.
    const php = `<?php
class C {
    public function a(Base $b) {}
    public function b(Base $b) {}
}`;
    expect(namesOf(php)).toEqual(["Base", "Base"]);
  });

  it("keeps `new Foo()` beside a `Foo()` call as its own, qualified edge", () => {
    // Same caller, same name, same kind, but not the same thing: `Foo()` calls
    // a function, and `new Foo()` names a class, which is qualified by its
    // namespace. Merged, the class reference was dropped for the function call.
    // The function call is left exactly as it was — unqualified, and first.
    const { rawCalls } = extractSymbolsAndCalls(
      "<?php\nnamespace App;\nfunction f() { Foo(); return new Foo(); }\n",
      "php", ".php", "t.php",
    );
    expect(rawCalls.filter((c) => c.calleeName === "Foo").map((c) => [c.kind, c.calleeQualifier]))
      .toEqual([["call", undefined], ["call", "\\App\\"]]);
  });

  it("emits no structural edge for a file that has none", () => {
    expect(refsIn("<?php\nfunction f($x) { return strlen($x); }\n")
      .filter((r) => r.kind === "type_reference")).toEqual([]);
  });

  it("preserves the existing call edges beside the new ones", () => {
    // Regression guard for the whole change: the three call-expression kinds
    // must keep producing exactly what they did.
    const php = `<?php
class LogoutController extends Controller {
    public function __invoke(Request $request): JsonResponse {
        $this->revoker->blacklistToken($accessToken);
        $response->headers->setCookie(AuthCookies::forgetAccess());
        return $response;
    }
}`;
    const calls = refsIn(php).filter((r) => r.kind === "call").map((r) => r.calleeName);
    expect(new Set(calls)).toEqual(new Set(["blacklistToken", "setCookie", "forgetAccess"]));
    expect(new Set(namesOf(php)))
      .toEqual(new Set(["Controller", "Request", "JsonResponse"]));
  });

  /**
   * `use` is scoped to its namespace, not to its file.
   *
   * A single alias table per file applies an import where nothing declares one,
   * which fabricates an edge to a class the file never names — the one failure
   * mode this extractor is built to avoid, and strictly worse than the omission
   * the structural edges were added to fix.
   */
  describe("namespace-scoped `use` aliases", () => {
    it("confines a braced namespace's alias to its own block", () => {
      // `B` imports nothing, so `extends Al` there names `B\Al`. Rewriting it
      // to `Base` would point the edge at `A`'s import — a class `B` never
      // mentions.
      const php = `<?php
namespace A { use X\\Base as Al; class One extends Al {} }
namespace B { class Two extends Al {} }
`;
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
        { calleeName: "Al", kind: "type_reference" },
      ]);
    });

    it("gives each braced block its own meaning for the same local spelling", () => {
      const php = `<?php
namespace A { use X\\Base as Al; class One extends Al {} }
namespace B { use Y\\Other as Al; class Two extends Al {} }
`;
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
        { calleeName: "Other", kind: "type_reference", localAlias: "Al" },
      ]);
    });

    it("tells two braced blocks apart when they share a line", () => {
      // Two namespace blocks on one line is legal PHP, so the block a
      // reference belongs to cannot be decided by line number — only by its
      // source offset.
      const php =
        "<?php\nnamespace A { use X\\Base as Al; class One extends Al {} }"
        + " namespace B { class Two extends Al {} }\n";
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
        { calleeName: "Al", kind: "type_reference" },
      ]);
    });

    it("scopes an unbraced namespace's alias to the run of code it opens", () => {
      // `namespace A;` runs to the next `namespace` statement, so `B` is no
      // more entitled to `A`'s import than a braced block would be.
      const php = `<?php
namespace A;
use X\\Base as Al;
class One extends Al {}

namespace B;
class Two extends Al {}
`;
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
        { calleeName: "Al", kind: "type_reference" },
      ]);
    });

    it("resolves through the block's own `use` in a single braced namespace", () => {
      // Non-regression guard: the common single-namespace file must keep the
      // behaviour it already had.
      const php = `<?php
namespace A {
    use X\\Base as Al;
    class One extends Al {}
}
`;
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
      ]);
    });

    it("resolves through the file's `use` in a single unbraced namespace", () => {
      // Non-regression guard: the shape of nearly every PSR-4 autoloaded class.
      const php = `<?php
namespace App\\Models;

use X\\Base as Al;

class One extends Al {}
`;
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
      ]);
    });

    it("resolves through the file's `use` when the file declares no namespace", () => {
      // Non-regression guard: no namespace means no scope to fall back from.
      expect(refsIn("<?php\nuse X\\Base as Al;\nclass One extends Al {}\n")).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
      ]);
    });
  });

  /**
   * `use` is scoped to the code that FOLLOWS it, not to the whole namespace.
   *
   * PHP resolves a name at compile time against the imports seen so far, so an
   * alias declared below a reference never reaches it. Verified against the
   * runtime: `namespace A; class One extends Al {} use X\Base as Al;` fatals
   * with `Class "A\Al" not found`, while the same file with the `use` moved
   * above the class resolves the parent to `X\Base`. Applying the alias
   * backwards therefore names a class the reference does not — a fabricated
   * edge, which is the one outcome this extractor must not produce.
   */
  describe("position-scoped `use` aliases", () => {
    it("does not apply an alias declared after the reference", () => {
      // `Al` here is `A\Al`, which nothing imports; the honest edge keeps the
      // raw spelling and stays unresolved rather than pointing at `X\Base`.
      const php = "<?php\nnamespace A; class One extends Al {} use X\\Base as Al;\n";
      expect(refsIn(php)).toEqual([{ calleeName: "Al", kind: "type_reference" }]);
    });

    it("still applies an alias declared before the reference", () => {
      // Positive control for the test above: the fix must be position-aware,
      // not "drop every alias". Same file, `use` moved ahead of the class.
      const php = "<?php\nnamespace A; use X\\Base as Al; class One extends Al {}\n";
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
      ]);
    });

    it("applies the same rule through the no-namespace fallback", () => {
      // The whole-file fallback is a separate path from the per-namespace
      // tables, and the runtime is just as strict there: the global-scope form
      // fatals with `Class "Al" not found`.
      const php = "<?php\nclass One extends Al {}\nuse X\\Base as Al;\n";
      expect(refsIn(php)).toEqual([{ calleeName: "Al", kind: "type_reference" }]);
    });

    it("keeps a later reference resolving through an earlier `use`", () => {
      // Positive control for the fallback: one `use` at the top of a
      // namespace-free file must still reach everything below it.
      const php = "<?php\nuse X\\Base as Al;\nclass One extends Al {}\nclass Two extends Al {}\n";
      expect(refsIn(php)).toEqual([
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
        { calleeName: "Base", kind: "type_reference", localAlias: "Al" },
      ]);
    });
  });
});
