// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractSymbolsAndCalls } from "../../src/services/graph-symbols.js";

/**
 * Ruby call edges. `extractFromRuby` collects `call` nodes, but used to name
 * them with the JavaScript extractor, which requires a `(` before the callee.
 * Ruby lets you omit parentheses, and idiomatic Ruby overwhelmingly does —
 * Rails DSL (`has_many :posts`), callbacks (`run_callbacks :save`), plain
 * receiver calls (`logger.info msg`). All of those resolved to null and were
 * dropped, so Ruby files contributed almost no call edges and
 * `codebase_impact` under-reported callers throughout Ruby codebases. The
 * callee now comes from the grammar's `method` field, which names every call
 * shape.
 */
describe("Ruby call-site extraction", () => {
  // Ruby is a dynamically-registered ast-grep grammar. Without this the parse
  // throws, `safeFindAll` swallows it, and every assertion sees an empty list —
  // a silent pass-by-vacuum rather than a failure.
  beforeAll(() => ensureDynamicLanguages());

  const callsIn = (rb: string): string[] => {
    // Signature is (source, lang, ext, relativePath) — see the PHP suite for
    // why the argument order matters to what is actually tested.
    const { rawCalls } = extractSymbolsAndCalls(rb, "ruby", ".rb", "t.rb");
    return rawCalls.map((c) => c.calleeName);
  };

  it("names a parenthesis-less receiver call", () => {
    const calls = callsIn("logger.info 'saved'\n");
    expect(calls).toEqual(["info"]);
  });

  it("names a command-style DSL call with a symbol argument", () => {
    const calls = callsIn("class User\n  has_many :posts\n  validates :name\nend\n");
    expect(calls).toHaveLength(2);
    expect(calls.sort()).toEqual(["has_many", "validates"]);
  });

  it("still names parenthesised calls exactly as before", () => {
    const calls = callsIn("class A\n  def run\n    helper()\n    obj.method(1)\n  end\nend\n");
    expect(calls).toHaveLength(2);
    expect(calls.sort()).toEqual(["helper", "method"]);
  });

  it("names each link of a fluent chain as its own call", () => {
    const calls = callsIn("Model.where(x: 1).order(:y).first\n");
    // One call node per link — the count matters: a first-`(`-based parse
    // would collapse or drop links.
    expect(calls).toHaveLength(3);
    expect(calls.sort()).toEqual(["first", "order", "where"]);
  });

  it("names a block call and the calls inside the block", () => {
    const calls = callsIn("items.each do |i|\n  process i\nend\n");
    expect(calls).toHaveLength(2);
    expect(calls.sort()).toEqual(["each", "process"]);
  });

  it("names a safe-navigation call", () => {
    expect(callsIn("user&.destroy\n")).toEqual(["destroy"]);
  });

  it("attributes calls to the enclosing method scope", () => {
    const src = "class User\n  def save!\n    run_callbacks :save\n  end\nend\n";
    const { rawCalls } = extractSymbolsAndCalls(src, "ruby", ".rb", "user.rb");
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].calleeName).toBe("run_callbacks");
    expect(rawCalls[0].callerId).toContain("save!");
  });

  it("does not invent a call for a bare identifier (grammar-ambiguous with a variable read)", () => {
    // `helper` with no receiver, no args and no parens parses as a plain
    // identifier. Recording it would fabricate edges from every variable
    // mention, which is worse than the missing edge.
    expect(callsIn("helper\n")).toEqual([]);
  });

  it("captures every call in a realistic Rails-style body, with counts", () => {
    const src = [
      "class User",
      "  has_many :posts",
      "  validates :name",
      "  def save!",
      "    run_callbacks :save",
      "    persist(self)",
      "    logger.info 'saved'",
      "  end",
      "end",
      "",
    ].join("\n");
    const calls = callsIn(src);
    // Count, not just the distinct set: duplicates or dropped links would
    // otherwise pass unnoticed (same lesson as the PHP suite).
    expect(calls).toHaveLength(5);
    expect(calls.sort()).toEqual(["has_many", "info", "persist", "run_callbacks", "validates"]);
  });
});
