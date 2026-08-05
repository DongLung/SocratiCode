// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractSymbolsAndCalls, resetSymbolExtractionWarnings } from "../../src/services/graph-symbols.js";

/**
 * Plain-JS files with a `class` used to contribute a bare module symbol and
 * zero call edges. The class-name lookup asked for `type_identifier`, a kind
 * the TypeScript grammar defines and the JavaScript grammar does not — and
 * ast-grep throws on an unknown kind rather than returning null, so the
 * `?? identifier` fallback written for exactly this case never ran; the throw
 * escaped to the outer catch, which discarded the whole file's extraction.
 * `.js`, `.jsx`, `.mjs` and `.cjs` all parse with the JavaScript grammar, so
 * every plain-JS codebase with classes silently lost its symbol graph.
 */
describe("plain-JS class extraction", () => {
  beforeAll(() => {
    ensureDynamicLanguages();
    resetSymbolExtractionWarnings();
  });

  const JS_WITH_CLASS = [
    "function alpha() { return beta(); }",
    "function beta() { return 1; }",
    "class Gamma {",
    "  constructor() { this.n = 0; }",
    "  run() { return alpha(); }",
    "}",
    "alpha();",
  ].join("\n");

  it("extracts the class, its methods, and the surrounding functions", () => {
    const { symbols } = extractSymbolsAndCalls(JS_WITH_CLASS, Lang.JavaScript, ".js", "f.js");
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain("Gamma");
    expect(names).toContain("Gamma.run");
    expect(names).toContain("Gamma.constructor");
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("keeps the call edges a class used to destroy", () => {
    const { rawCalls } = extractSymbolsAndCalls(JS_WITH_CLASS, Lang.JavaScript, ".js", "f.js");
    // The exact loss mode was zero calls for the entire file.
    expect(rawCalls.length).toBeGreaterThanOrEqual(3);
    const names = rawCalls.map((c) => c.calleeName);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("attributes a call inside a method to that method, not the module", () => {
    const { symbols, rawCalls } = extractSymbolsAndCalls(JS_WITH_CLASS, Lang.JavaScript, ".js", "f.js");
    const run = symbols.find((s) => s.qualifiedName === "Gamma.run");
    const fromRun = rawCalls.find((c) => c.calleeName === "alpha" && c.callerId === run?.id);
    expect(fromRun).toBeDefined();
  });

  it("names a decorated class by its own name, not its decorator's", () => {
    // A recursive search reaches the decorator's identifier first, so this
    // used to extract as a class named `sealed`.
    const src = "function sealed(c) { return c; }\n@sealed\nclass DecoTarget {\n  go() { return 1; }\n}\n";
    const { symbols } = extractSymbolsAndCalls(src, Lang.JavaScript, ".js", "f.js");
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain("DecoTarget");
    expect(names).toContain("DecoTarget.go");
    expect(symbols.filter((s) => s.name === "sealed" && s.kind === "class")).toHaveLength(0);
  });

  it("does not stamp object-literal handlers onto the class as methods", () => {
    // Shorthand methods in a field initializer are the dominant plain-JS
    // handler idiom; a subtree scan persisted them as phantom class methods.
    const src = [
      "class Config {",
      "  handlers = { onDone() { return 1; }, onFail() { return 2; } };",
      "  real() { return 3; }",
      "}",
    ].join("\n");
    const { symbols } = extractSymbolsAndCalls(src, Lang.JavaScript, ".js", "f.js");
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain("Config.real");
    expect(names).not.toContain("Config.onDone");
    expect(names).not.toContain("Config.onFail");
  });

  it("does not double-stamp a nested class's methods onto the outer class", () => {
    const src = [
      "class Outer {",
      "  make() { return class Inner { innerRun() { return 1; } }; }",
      "}",
    ].join("\n");
    const { symbols } = extractSymbolsAndCalls(src, Lang.JavaScript, ".js", "f.js");
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain("Outer.make");
    expect(names).not.toContain("Outer.innerRun");
  });

  it("skips a computed method name instead of persisting a name that does not exist", () => {
    const src = "class Members {\n  [Symbol.iterator]() { return null; }\n  real() { return 1; }\n}\n";
    const { symbols } = extractSymbolsAndCalls(src, Lang.JavaScript, ".js", "f.js");
    const names = symbols.map((s) => s.qualifiedName);
    expect(names).toContain("Members.real");
    expect(names).not.toContain("Members.iterator");
  });

  it("still extracts TypeScript classes through the type_identifier path", () => {
    // The TS grammar DOES define type_identifier; the guard must not have
    // changed which node names a TS class.
    const ts = "class Keeper { move(): number { return help(); } }\nfunction help(): number { return 1; }\n";
    const { symbols } = extractSymbolsAndCalls(ts, Lang.TypeScript, ".ts", "f.ts");
    const keeper = symbols.find((s) => s.qualifiedName === "Keeper");
    expect(keeper).toBeDefined();
    expect(keeper?.kind).toBe("class");
    expect(symbols.map((s) => s.qualifiedName)).toContain("Keeper.move");
  });

  it("handles an anonymous class expression without inventing a name", () => {
    // No name field, no identifier of its own: must be skipped, not crash and
    // not steal the name of something nearby.
    const src = "const x = class { m() { return 1; } };\nfunction real() { return 2; }\n";
    const { symbols } = extractSymbolsAndCalls(src, Lang.JavaScript, ".js", "f.js");
    expect(symbols.map((s) => s.qualifiedName)).toContain("real");
  });
});
