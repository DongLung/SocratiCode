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
});
