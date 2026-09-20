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

  it("records a return type hint", () => {
    expect(namesOf("<?php\nclass C {\n    public function go(): Base {}\n}\n"))
      .toEqual(["Base"]);
  });

  it("records a constructor-promoted property's type", () => {
    // A promoted property is a parameter in the signature, and constructor
    // injection is where most modern PHP names its collaborators.
    expect(namesOf("<?php\nclass C {\n    public function __construct(private readonly Repo $r) {}\n}\n"))
      .toEqual(["Repo"]);
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

  it("names a leading-backslash FQCN by its terminal segment", () => {
    // Symbols are indexed under the short name they were declared with, so
    // only the last segment can ever match one.
    expect(namesOf("<?php\nclass X extends \\App\\Base\\Base {}\n")).toEqual(["Base"]);
  });

  it("names a namespace-relative path by its terminal segment", () => {
    expect(namesOf("<?php\nclass X extends Base\\Inner {}\n")).toEqual(["Inner"]);
  });

  it("names an FQCN in a `new` by its terminal segment", () => {
    expect(refsIn("<?php\nfunction f() { return new \\App\\Full\\Qualified(); }\n"))
      .toEqual([{ calleeName: "Qualified", kind: "call" }]);
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

  it("does not add a second edge for `new Foo()` beside a `Foo()` call", () => {
    // Same caller, same name, same kind — one edge, and the pre-existing call
    // edge is the one that survives.
    const calls = refsIn("<?php\nfunction f() { Foo(); return new Foo(); }\n")
      .filter((r) => r.calleeName === "Foo");
    expect(calls).toEqual([{ calleeName: "Foo", kind: "call" }]);
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
});
