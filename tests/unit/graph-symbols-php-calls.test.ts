// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractSymbolsAndCalls } from "../../src/services/graph-symbols.js";

/**
 * PHP call edges. `extractFromPhp` collects `member_call_expression` and
 * `scoped_call_expression` nodes, but used to name them with the JavaScript
 * extractor, whose chain pattern `[\w$.]+` stops at the `:` of `Cls::method(`
 * and the `-` of `$obj->method(`. Every method and static call therefore
 * resolved to null and was dropped, so only bare function calls survived and
 * `codebase_impact` reported no callers for any PHP symbol.
 */
describe("PHP call-site extraction", () => {
  // PHP is a dynamically-registered ast-grep grammar. Without this the parse
  // throws, `safeFindAll` swallows it, and every assertion sees an empty list —
  // a silent pass-by-vacuum rather than a failure.
  beforeAll(() => ensureDynamicLanguages());

  const callsIn = (php: string): string[] => {
    // Signature is (source, lang, ext, relativePath). Passing the path as
    // `lang` silently routes to the regex fallback, which handles `::`/`->`
    // already — so a wrong-arity call here would pass while testing nothing.
    const { rawCalls } = extractSymbolsAndCalls(php, "php", ".php", "t.php");
    return rawCalls.map((c) => c.calleeName);
  };

  it("names a static call by its method, not its class", () => {
    expect(callsIn("<?php\nAuthCookies::forgetAccess();\n")).toContain("forgetAccess");
  });

  it("names an instance call through a receiver chain", () => {
    expect(callsIn("<?php\n$this->revoker->blacklistToken($t);\n")).toContain("blacklistToken");
  });

  it("handles a fully-qualified static call", () => {
    expect(callsIn("<?php\n\\Acme\\Support\\Cookie::make('a');\n")).toContain("make");
  });

  it("still handles a plain function call", () => {
    expect(callsIn("<?php\nstrlen($x);\n")).toContain("strlen");
  });

  it("captures every call in a realistic method body", () => {
    const names = callsIn(`<?php
class LogoutController {
    public function __invoke(Request $request): JsonResponse {
        $this->revoker->blacklistToken($accessToken);
        $response->headers->setCookie(AuthCookies::forgetAccess());
        return $response;
    }
}`);
    expect(names).toEqual(expect.arrayContaining([
      "blacklistToken", "setCookie", "forgetAccess",
    ]));
  });

  it("drops nothing silently — a method call yields exactly one callee name", () => {
    // Regression guard: the old JS extractor returned null here.
    expect(callsIn("<?php\nCls::of($a);\n")).toEqual(["of"]);
  });

  it("names each link of a fluent chain distinctly", () => {
    // ast-grep reports one node per link and each node's text starts at the
    // head of the chain, so keying on the FIRST "(" names the outermost call
    // `where` — three times — instead of where/orderBy/get.
    const names = callsIn("<?php\nModel::where('x')->orderBy('y')->get();\n");

    expect(names).toHaveLength(3);
    expect(new Set(names)).toEqual(new Set(["where", "orderBy", "get"]));
  });

  it("is not confused by a parenthesis inside a string literal", () => {
    // A depth scan that ignores quoting unbalances here and mis-slices.
    const names = callsIn("<?php\nModel::where('a)b')->get();\n");

    // Length before the set: `new Set` collapses duplicates, so a partially
    // wrong ["where", "where", "get"] would satisfy the set alone.
    expect(names).toHaveLength(2);
    expect(new Set(names)).toEqual(new Set(["where", "get"]));
  });

  it("names a nested call by its own callee, not the enclosing one", () => {
    const names = callsIn("<?php\nFoo::bar(Baz::qux($v));\n");

    expect(names).toHaveLength(2);
    expect(new Set(names)).toEqual(new Set(["bar", "qux"]));
  });

  /**
   * PHP admits any non-ASCII character in an identifier, and the callee scan
   * is anchored at the end of the receiver. An ASCII-only pattern there did not
   * only drop a non-ASCII name: where the name ended in ASCII it matched that
   * tail alone, so `$o->crée()` was recorded as a call to `e`.
   */
  describe("non-ASCII identifiers", () => {
    it.each([
      ["an ASCII method, as before", "$o->render();", "render"],
      ["an accented method", "$o->crée();", "crée"],
      ["an accented method with a longer ASCII tail", "$o->données();", "données"],
      ["a Cyrillic method", "$o->данные();", "данные"],
      ["a CJK method", "$o->文書();", "文書"],
      ["a Cyrillic method that ends in ASCII", "$o->данныеJson();", "данныеJson"],
      ["a CJK method that ends in ASCII", "$o->文書Id();", "文書Id"],
      // Outside the BMP, so only a pattern without the `u` flag keeps it whole.
      ["a CJK method outside the BMP that ends in ASCII", "$o->𠮷Id();", "𠮷Id"],
      ["an accented function", "crée();", "crée"],
      ["an ASCII static method on an accented class", "Café::make();", "make"],
      ["a Cyrillic static method on a Cyrillic class", "Документ::создать();", "создать"],
    ])("names %s exactly", (_label, statement, expected) => {
      expect(callsIn(`<?php\n${statement}\n`)).toEqual([expected]);
    });

    /**
     * The parse's own BMP limit, pinned so a grammar change is not silent.
     * `name` stops at U+FFFF, so a declaration written past it is filed under
     * the remainder — `𠮷Id` becomes `Id` — while the callee scan reads the
     * call node's own text and keeps the character. Above the BMP the two
     * therefore never meet, and the call resolves to nothing. Truncating the
     * call to agree would be the `crée` → `e` bug again from the other side:
     * `Id` is a name the source does not write, and an unrelated `Id` in the
     * caller's dependency closure would answer it.
     */
    it("keeps a callee past the BMP whole, which the cut declaration cannot answer", () => {
      const { symbols, rawCalls } = extractSymbolsAndCalls(
        "<?php\nclass C {\n    public function \u{20BB7}Id(): void {}\n    public function run(): void { $this->\u{20BB7}Id(); }\n}\n",
        "php",
        ".php",
        "t.php",
      );
      expect(symbols.filter((s) => s.kind === "method").map((s) => s.name)).toEqual(["Id", "run"]);
      expect(rawCalls.map((c) => c.calleeName)).toEqual(["\u{20BB7}Id"]);
    });
  });
});
