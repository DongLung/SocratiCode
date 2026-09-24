// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractSymbolsAndCalls } from "../../src/services/graph-symbols.js";

/**
 * PHP qualifiers, at the extractor.
 *
 * A static call `Cls::m()` used to be emitted as the bare method name, and a
 * class reference as the bare class name, so resolution could only match by
 * name: `UserSchema::all()` inside `Schema::all()` became a self-edge, and
 * `Request::capture()` reached a same-named `Invoice::capture()`. The extractor
 * now resolves the class a call or reference names under the file's namespace
 * and `use` imports, and carries it on the edge as `calleeQualifier`; every PHP
 * class and method carries what declares it as `phpOwner`. Resolution matches
 * the two.
 */
describe("PHP qualifiers at the extractor", () => {
  // PHP is a dynamically-registered ast-grep grammar. Without this the parse
  // throws, `safeFindAll` swallows it, and every assertion below sees an empty
  // list — a silent pass-by-vacuum rather than a failure.
  beforeAll(() => ensureDynamicLanguages());

  const extract = (php: string) => extractSymbolsAndCalls(php, "php", ".php", "t.php");

  /** Each call's `[method, qualifier]`, in emission order; the qualifier is absent when unqualified. */
  const callsIn = (php: string): Array<[string, string | undefined]> =>
    extract(php).rawCalls
      .filter((c) => c.kind === "call")
      .map((c) => [c.calleeName, c.calleeQualifier]);

  /** Each symbol's `[name, owner]`, module excluded. */
  const ownersIn = (php: string): Array<[string, string | undefined]> =>
    extract(php).symbols
      .filter((s) => s.kind !== "module")
      .map((s) => [s.name, s.phpOwner]);

  describe("a static call is qualified by the class it names", () => {
    it.each([
      [
        "a bare class, under the current namespace",
        "namespace App\\Http;\nInvoice::capture();",
        "\\App\\Http\\Invoice",
      ],
      [
        "a bare class a `use` imports",
        "namespace App\\Http;\nuse Illuminate\\Http\\Request;\nRequest::capture();",
        "\\Illuminate\\Http\\Request",
      ],
      [
        "an alias, as the class it renames",
        "namespace App\\Http;\nuse App\\Models\\Invoice as Bill;\nBill::capture();",
        "\\App\\Models\\Invoice",
      ],
      [
        "an alias from a grouped `use`, prefix included",
        "namespace App\\Http;\nuse App\\Models\\{Invoice, Order as O};\nO::all();",
        "\\App\\Models\\Order",
      ],
      [
        "a qualified name, through an imported first segment",
        "namespace App\\Http;\nuse App\\Models as M;\nM\\Invoice::capture();",
        "\\App\\Models\\Invoice",
      ],
      [
        "a qualified name, under the current namespace when nothing imports it",
        "namespace App;\nSub\\Invoice::capture();",
        "\\App\\Sub\\Invoice",
      ],
      [
        "a namespace-relative name",
        "namespace App\\Http;\nnamespace\\Invoice::capture();",
        "\\App\\Http\\Invoice",
      ],
      [
        "a fully qualified name, whatever the file imports",
        "namespace App\\Http;\nuse X\\Y as Invoice;\n\\App\\Models\\Invoice::capture();",
        "\\App\\Models\\Invoice",
      ],
      [
        "a bare class in a file with no namespace, in the global namespace",
        "Invoice::capture();",
        "\\Invoice",
      ],
      [
        "an import matched case-insensitively, as PHP matches class names",
        "namespace App\\Http;\nuse App\\Models\\Invoice;\nINVOICE::capture();",
        "\\App\\Models\\Invoice",
      ],
    ])("%s", (_label, body, qualifier) => {
      // Every row calls `capture` except the grouped one, which calls `all`.
      const method = body.includes("O::all()") ? "all" : "capture";
      expect(callsIn(`<?php\n${body}\n`)).toEqual([[method, qualifier]]);
    });

    it("gives each braced namespace block its own namespace and imports", () => {
      const php = `<?php
namespace A { use X\\Tool; class One { function f() { Tool::run(); Helper::run(); } } }
namespace B { class Two { function f() { Tool::run(); } } }
`;
      expect(callsIn(php)).toEqual([
        ["run", "\\X\\Tool"],
        ["run", "\\A\\Helper"],
        ["run", "\\B\\Tool"],
      ]);
    });

    it("does not apply a `use` declared below the call", () => {
      // PHP reads an import from its declaration down, so above it the bare
      // name is still the current namespace's.
      expect(callsIn("<?php\nnamespace App;\nTool::run();\nuse X\\Tool;\n"))
        .toEqual([["run", "\\App\\Tool"]]);
    });
  });

  describe("everything else is left unqualified, and resolves as it did", () => {
    it.each([
      ["`self::`", "class C { function f() { self::m(); } }"],
      ["`static::`", "class C { function f() { static::m(); } }"],
      ["`parent::`", "class C extends B { function f() { parent::m(); } }"],
      ["a class held in a variable", "function f($cls) { $cls::m(); }"],
      ["an instance call", "function f($o) { $o->m(); }"],
      ["a bare function call", "function f() { m(); }"],
      ["a qualified function call", "function f() { \\App\\m(); }"],
    ])("%s", (_label, body) => {
      const calls = callsIn(`<?php\nnamespace App;\n${body}\n`).filter(([name]) => name === "m");
      expect(calls).toEqual([["m", undefined]]);
    });
  });

  describe("a class reference is qualified by the namespace it names", () => {
    it("qualifies every structural position the same way", () => {
      const php = `<?php
namespace App\\Http;
use App\\Models\\Invoice;
use App\\Contracts as C;
class Controller extends Base implements C\\Billable {
    use \\App\\Traits\\Logs;
    private Invoice $invoice;
    public function make(Invoice $i): namespace\\Receipt { return new Invoice(); }
}
`;
      const refs = extract(php).rawCalls.map((c) => [c.kind, c.calleeName, c.calleeQualifier]);
      expect(refs).toEqual(expect.arrayContaining([
        ["type_reference", "Base", "\\App\\Http\\"],
        ["type_reference", "Billable", "\\App\\Contracts\\"],
        ["type_reference", "Logs", "\\App\\Traits\\"],
        ["type_reference", "Invoice", "\\App\\Models\\"],
        ["type_reference", "Receipt", "\\App\\Http\\"],
        ["call", "Invoice", "\\App\\Models\\"],
      ]));
    });

    it("qualifies a class in the global namespace with `\\`", () => {
      expect(extract("<?php\nclass C extends \\Exception {}\n").rawCalls
        .map((c) => [c.calleeName, c.calleeQualifier]))
        .toEqual([["Exception", "\\"]]);
    });

    it("reads a namespace-relative `extends` and `new`, which were not read before", () => {
      const php = "<?php\nnamespace App;\nclass C extends namespace\\Base { function f() { return new namespace\\Made(); } }\n";
      expect(extract(php).rawCalls.map((c) => [c.kind, c.calleeName, c.calleeQualifier])).toEqual([
        ["type_reference", "Base", "\\App\\"],
        ["call", "Made", "\\App\\"],
      ]);
    });

    it("keeps two same-named classes from two namespaces as two edges", () => {
      // Qualified, they are different targets; the dedupe that merged them by
      // short name would have kept only one.
      const php = "<?php\nnamespace App;\nuse X\\Foo;\nfunction f(Foo $a, \\Y\\Foo $b) {}\n";
      expect(extract(php).rawCalls.map((c) => [c.calleeName, c.calleeQualifier]))
        .toEqual([["Foo", "\\X\\"], ["Foo", "\\Y\\"]]);
    });
  });

  describe("every PHP class and method carries what declares it", () => {
    it("owns a class by its namespace, and a method by its class", () => {
      const php = `<?php
namespace App\\Models;
class Invoice { public static function capture() {} }
interface Billable { public function bill(); }
trait Logs { public function log() {} }
enum Status { case A; public function label() {} }
function helper() {}
`;
      // Class-likes first, then functions, then methods: the extractor's own
      // registration order. A function is owned by nothing — no qualified edge
      // targets one — and an enum registers no symbol of its own, though its
      // methods are owned by it.
      expect(ownersIn(php)).toEqual([
        ["Invoice", "\\App\\Models\\"],
        ["Billable", "\\App\\Models\\"],
        ["Logs", "\\App\\Models\\"],
        ["helper", undefined],
        ["capture", "\\App\\Models\\Invoice"],
        ["bill", "\\App\\Models\\Billable"],
        ["log", "\\App\\Models\\Logs"],
        ["label", "\\App\\Models\\Status"],
      ]);
    });

    it("owns a class in a file with no namespace by the global namespace", () => {
      expect(ownersIn("<?php\nclass C { function m() {} }\n"))
        .toEqual([["C", "\\"], ["m", "\\C"]]);
    });

    it("owns each braced block's classes by that block's namespace", () => {
      const php = "<?php\nnamespace A { class One { function m() {} } }\nnamespace B { class Two { function m() {} } }\n";
      expect(ownersIn(php)).toEqual([
        ["One", "\\A\\"],
        ["Two", "\\B\\"],
        ["m", "\\A\\One"],
        ["m", "\\B\\Two"],
      ]);
    });

    it("gives a method of an anonymous class no owner, since no name reaches it", () => {
      const php = "<?php\nnamespace App;\n$o = new class { public function m() {} };\n";
      expect(ownersIn(php)).toEqual([["m", undefined]]);
    });

    it("gives an abstract method no owner, since no call runs it", () => {
      // A trait's `abstract` method only requires one; PHP runs the class's
      // own or inherited implementation, so a qualified edge must not stop at
      // the declaration. The concrete method beside it is owned as usual.
      const php = [
        "<?php",
        "namespace App;",
        "trait T { abstract public static function make(): static; }",
        "abstract class A { abstract protected function g(); public function h() {} }",
      ].join("\n");
      expect(ownersIn(php)).toEqual([
        ["A", "\\App\\"],
        ["T", "\\App\\"],
        ["make", undefined],
        ["g", undefined],
        ["h", "\\App\\A"],
      ]);
    });

    it("owns a method by its class's real name, not an attribute's", () => {
      // An attribute list sits inside the declaration ahead of the name, so
      // reading the first `name` descendant would own `m` by `Entity`.
      const php = "<?php\nnamespace App;\n#[Entity]\nclass User { public function m() {} }\n";
      expect(ownersIn(php).find(([name]) => name === "m")).toEqual(["m", "\\App\\User"]);
    });

    it("leaves every symbol's id and qualified name exactly as they were", () => {
      const { symbols } = extract("<?php\nnamespace App\\Models;\nclass Invoice {\n    public static function capture() {}\n}\n");
      expect(symbols.filter((s) => s.kind !== "module").map((s) => [s.id, s.qualifiedName])).toEqual([
        ["t.php::Invoice#3", "Invoice"],
        ["t.php::capture#4", "capture"],
      ]);
    });
  });

  describe("a class records what it inherits static methods from", () => {
    /** Each class-like's `[name, phpExtends, phpTraits]`. */
    const inheritanceIn = (php: string): Array<[string, string | undefined, string[] | undefined]> =>
      extract(php).symbols
        .filter((s) => s.kind === "class" || s.kind === "interface" || s.kind === "trait")
        .map((s) => [s.name, s.phpExtends, s.phpTraits]);

    it("records the parent and traits, each resolved under the namespace and imports", () => {
      const php = [
        "<?php",
        "namespace App\\Models;",
        "use Vendor\\Orm\\Model as Base;",
        "use Vendor\\Concerns;",
        "class User extends Base {",
        "    use HasSlug, Concerns\\HasTag;",
        "    use \\Vendor\\Loud;",
        "}",
      ].join("\n");
      expect(inheritanceIn(php)).toEqual([
        ["User", "\\Vendor\\Orm\\Model", ["\\App\\Models\\HasSlug", "\\Vendor\\Concerns\\HasTag", "\\Vendor\\Loud"]],
      ]);
    });

    it("records a trait's own traits, and neither field where there is nothing to record", () => {
      const php = "<?php\nnamespace App;\ntrait T { use U; }\ntrait U {}\nclass C {}\n";
      expect(inheritanceIn(php)).toEqual([
        ["C", undefined, undefined],
        ["T", undefined, ["\\App\\U"]],
        ["U", undefined, undefined],
      ]);
    });

    it("does not record an interface's parents", () => {
      expect(inheritanceIn("<?php\nnamespace App;\ninterface I extends J, K {}\n")).toEqual([["I", undefined, undefined]]);
    });

    it("reads a trait's name, not its alias list", () => {
      const php = "<?php\nnamespace App;\nclass C { use T { a as b; } }\n";
      expect(inheritanceIn(php)).toEqual([["C", undefined, ["\\App\\T"]]]);
    });

    it("does not take a nested anonymous class's parent or traits for its container's", () => {
      const php = "<?php\nnamespace App;\nclass C {\n    public function m() { return new class extends P { use T; }; }\n}\n";
      expect(inheritanceIn(php)).toEqual([["C", undefined, undefined]]);
    });

    it("records no parent the parse cut short", () => {
      const php = "<?php\nnamespace Top;\nclass C extends \u{20BB7}\\App\\Made {}\n";
      expect(inheritanceIn(php)).toEqual([["C", undefined, undefined]]);
    });
  });

  describe("a class name the parse cut short qualifies nothing", () => {
    // The grammar's `name` token stops at the BMP, so a fragment in front of a
    // `\`-rooted name leaves the node reading `\App\Made`. Qualified by what
    // survived, the edge would name `App\Made`, a class the source never writes.
    it("leaves a static call on a cut name unqualified", () => {
      expect(callsIn("<?php\nnamespace Top;\n\u{20BB7}\\App\\Made::run();\n")).toEqual([["run", undefined]]);
    });

    it("emits no class reference for `new` on a cut name", () => {
      const refs = extract("<?php\nnamespace Top;\nfunction f() { return new \u{20BB7}\\App\\Made(); }\n")
        .rawCalls.filter((c) => c.calleeName === "Made");
      expect(refs).toEqual([]);
    });

    it("keeps `new\\App\\Made()`, where the `\\` ends an ASCII keyword", () => {
      const refs = extract("<?php\nnamespace Top;\nfunction f() { return new\\App\\Made(); }\n")
        .rawCalls.filter((c) => c.calleeName === "Made");
      expect(refs.map((c) => c.calleeQualifier)).toEqual(["\\App\\"]);
    });
  });
});
