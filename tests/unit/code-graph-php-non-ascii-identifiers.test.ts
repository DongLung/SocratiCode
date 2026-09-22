// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import type { SymbolEdge } from "../../src/types.js";

/**
 * Non-ASCII PHP identifiers through the real `buildCodeGraph` +
 * `resolveCallSites` pass.
 *
 * The extractor tests prove the names are read whole; only a real build proves
 * what a truncated name would have done. Three of the non-ASCII methods below
 * end in an ASCII tail, and `decoys.php` declares a function under exactly each
 * tail and is required by the caller, so it sits inside the dependency closure
 * the untargeted scan searches. A call cut down to its tail therefore did not go
 * missing — it resolved, with `unique` confidence, to a function the caller
 * never names. The assertions hold both halves: every call reaches the method
 * it names, and nothing reaches a decoy.
 */
describe("PHP non-ASCII identifiers in a real graph", () => {
  let root: string;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  const CALLER = "src/Report/Document.php";
  const DECOYS = "src/Helpers/decoys.php";

  /** The single resolved edge under one name and kind, failing loudly if there is not exactly one. */
  const edge = (file: string, name: string, kind: SymbolEdge["kind"]): SymbolEdge => {
    const found = (graph.outgoingCallsByFile.get(file) ?? [])
      .filter((e) => e.calleeName === name && e.kind === kind);
    expect(found, `expected one ${kind} edge to ${name} in ${file}`).toHaveLength(1);
    return found[0];
  };

  /** The id of the one symbol a file declares under a name. */
  const idOf = (file: string, name: string): string => {
    const found = (graph.symbolsByFile.get(file) ?? []).filter((s) => s.name === name);
    expect(found, `expected one symbol ${name} in ${file}`).toHaveLength(1);
    return found[0].id;
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "socraticode-php-non-ascii-"));

    write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));

    // The ASCII tails an ASCII-only callee scan cut the method names below
    // down to. Nothing in the project calls any of them.
    write(DECOYS, `<?php

namespace App\\Helpers;

function e(): void {}

function Json(): void {}

function Id(): void {}
`);

    write("src/Model/Formatter.php", `<?php

namespace App\\Model;

class Formatter
{
    public function crée(): void {}

    public function данные(): void {}

    public function данныеJson(): void {}

    public function 文書(): void {}

    public function 文書Id(): void {}
}
`);

    // Class names outside Latin-1. Neither has a composed character, so the
    // path is the same whichever Unicode normalization the filesystem applies.
    write("src/Model/Документ.php", `<?php

namespace App\\Model;

class Документ {}
`);

    write("src/Model/報告.php", `<?php

namespace App\\Model;

class 報告 {}
`);

    write(CALLER, `<?php

namespace App\\Report;

use App\\Model\\Formatter;
use App\\Model\\Документ;
use App\\Model\\報告;

require_once __DIR__ . '/../Helpers/decoys.php';
// The file-import graph reads \`use\` clauses with an ASCII-only pattern of its
// own, outside the symbol extractor this suite covers, so the two \`use\`
// lines above reach no file. These supply the file edges instead.
require_once __DIR__ . '/../Model/Документ.php';
require_once __DIR__ . '/../Model/報告.php';

class Document
{
    public function render(Formatter $f, Документ $d): 報告
    {
        $f->crée();
        $f->данные();
        $f->данныеJson();
        $f->文書();
        $f->文書Id();

        return new 報告();
    }
}
`);

    graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
      graph.rustInlineDeclaredSymbols,
      graph.rustCrateRootsByFile,
    );
  }, 60_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("has the decoys inside the caller's dependency closure", () => {
    // Without this edge the decoy assertions below would pass vacuously: a
    // truncated call cannot resolve to a file the scan never searches.
    expect(graph.edges.some((e) => e.source === CALLER && e.target === DECOYS)).toBe(true);
  });

  it.each([
    ["an accented", "crée"],
    ["a Cyrillic", "данные"],
    ["a Cyrillic, ASCII-tailed", "данныеJson"],
    ["a CJK", "文書"],
    ["a CJK, ASCII-tailed", "文書Id"],
  ])("resolves %s method to the method it names", (_label, name) => {
    const e = edge(CALLER, name, "call");
    expect(e.calleeCandidates).toEqual([idOf("src/Model/Formatter.php", name)]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves nothing to a function named by an ASCII tail", () => {
    const intoDecoys = [...graph.outgoingCallsByFile.values()]
      .flat()
      .filter((e) => (e.calleeCandidates ?? []).some((id) => id.startsWith(`${DECOYS}::`)));
    expect(intoDecoys).toEqual([]);
  });

  it.each([
    ["a Cyrillic", "Документ", "src/Model/Документ.php"],
    ["a CJK", "報告", "src/Model/報告.php"],
  ])("resolves a type reference to %s class", (_label, name, file) => {
    const e = edge(CALLER, name, "type_reference");
    expect(e.calleeCandidates).toEqual([idOf(file, name)]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves `new` on a CJK class", () => {
    const e = edge(CALLER, "報告", "call");
    expect(e.calleeCandidates).toEqual([idOf("src/Model/報告.php", "報告")]);
    expect(e.confidence).toBe("unique");
  });
});
