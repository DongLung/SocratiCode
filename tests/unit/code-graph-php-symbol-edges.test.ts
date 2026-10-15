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
 * PHP structural edges through the real `buildCodeGraph` + `resolveCallSites`
 * pass, on the Composer layout the report was filed against.
 *
 * The extractor unit test proves the edges are emitted; only a real build
 * proves they *resolve*, and resolution is where the shape of the edge decides
 * the answer. An edge carrying a backslashed FQCN as `sourceModule` takes the
 * module-targeted branch, which matches a path and cannot read one, so it
 * comes back `unresolved` — and it additionally suppresses the same-file
 * branch, which is guarded on `!sourceModule`. The edges below carry neither
 * `sourceModule` nor `importedName`, so each takes the untargeted scan over
 * the caller's own resolved dependencies, which the `use` + PSR-4 machinery
 * produced. Nothing here can pass against an extractor that names the right
 * class in the wrong field.
 *
 * `Base.php` must therefore be reached from `Caller.php` and `Child.php`, and
 * `Child.php` from `Consumer.php` — the three edges the report says are
 * missing from file-mode `codebase_impact` while `codebase_graph_query` lists
 * them.
 */
describe("PHP structural symbol edges", () => {
  let root: string;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  /** Every resolved edge a file emits under one callee name, optionally one kind. */
  const edgesOf = (file: string, name: string, kind?: SymbolEdge["kind"]): SymbolEdge[] =>
    (graph.outgoingCallsByFile.get(file) ?? []).filter(
      (e) => e.calleeName === name && (kind === undefined || e.kind === kind),
    );

  /** The single edge under one name and kind, failing loudly if there is not exactly one. */
  const edge = (file: string, name: string, kind?: SymbolEdge["kind"]): SymbolEdge => {
    const found = edgesOf(file, name, kind);
    expect(found, `expected one ${kind ?? "any"} edge to ${name} in ${file}`).toHaveLength(1);
    return found[0];
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "socraticode-php-edges-"));

    // PHP namespaces carry no path information, so the manifest is the only
    // authority on where `App\` lives — and the dependency scan these edges
    // rely on is exactly the set of imports it resolves.
    write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));

    write("src/Base/Base.php", `<?php

namespace App\\Base;

class Base
{
    public function hello(): string
    {
        return 'hi';
    }
}
`);

    // Reaches Base through `extends` alone — no call, no type hint.
    write("src/Child/Child.php", `<?php

namespace App\\Child;

use App\\Base\\Base;

class Child extends Base
{
}
`);

    // Reaches Base twice: the pre-existing call edge on `hello()`, and the
    // parameter type hint that had none.
    write("src/Caller/Caller.php", `<?php

namespace App\\Caller;

use App\\Base\\Base;

class Caller
{
    public function go(Base $b): string
    {
        return $b->hello();
    }
}
`);

    // Reaches Child through `new` and a return type, neither of which is a call.
    write("src/Consumer/Consumer.php", `<?php

namespace App\\Consumer;

use App\\Child\\Child;

class Consumer
{
    public function make(): Child
    {
        return new Child();
    }
}
`);

    // The alias case: the file never writes the name its target declares.
    write("src/Alias/Aliased.php", `<?php

namespace App\\Alias;

use App\\Base\\Base as Ancestor;

class Aliased extends Ancestor
{
}
`);

    // A second class whose short name is `Base`. Aliasing is how PHP itself
    // handles two classes sharing a short name, so this is the real shape of
    // the ambiguity, not a contrived one.
    write("src/Dup/Base.php", `<?php

namespace App\\Dup;

class Base
{
    public function hello(): string
    {
        return 'dup';
    }
}
`);

    write("src/Ambiguous/Ambiguous.php", `<?php

namespace App\\Ambiguous;

use App\\Base\\Base;
use App\\Dup\\Base as DupBase;

class Ambiguous
{
    public function pick(Base $b, DupBase $d): string
    {
        return $b->hello();
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
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("resolves `extends` from Child.php to Base.php", async () => {
    // The report's first missing edge. Child.php calls nothing at all, so
    // before this it contributed no symbol edge and Base.php had no dependent.
    const e = edge("src/Child/Child.php", "Base", "type_reference");
    expect(e.calleeCandidates).toEqual(["src/Base/Base.php::Base#5"]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves a parameter type hint from Caller.php to Base.php", async () => {
    const e = edge("src/Caller/Caller.php", "Base", "type_reference");
    expect(e.calleeCandidates).toEqual(["src/Base/Base.php::Base#5"]);
    expect(e.confidence).toBe("unique");
  });

  it("keeps Caller.php's existing call edge on `hello()` resolving as it did", async () => {
    // The regression guard at the build level: adding type edges must not
    // disturb the call edges that were already there.
    const e = edge("src/Caller/Caller.php", "hello", "call");
    expect(e.calleeCandidates).toEqual(["src/Base/Base.php::hello#7"]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves `new Child()` from Consumer.php to Child.php", async () => {
    // Recorded as a `call`, the way the TypeScript extractor records `new`.
    const e = edge("src/Consumer/Consumer.php", "Child", "call");
    expect(e.calleeCandidates).toEqual(["src/Child/Child.php::Child#7"]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves Consumer.php's return type to Child.php as well", async () => {
    const e = edge("src/Consumer/Consumer.php", "Child", "type_reference");
    expect(e.calleeCandidates).toEqual(["src/Child/Child.php::Child#7"]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves an aliased `extends` under the name the target declares", async () => {
    // `Aliased.php` writes `Ancestor` and `Base.php` declares `Base`, so an
    // edge carrying the local spelling would resolve to nothing. The alias is
    // kept beside it rather than instead of it.
    const e = edge("src/Alias/Aliased.php", "Base", "type_reference");
    expect(e.localAlias).toBe("Ancestor");
    expect(e.calleeCandidates).toEqual(["src/Base/Base.php::Base#5"]);
    expect(e.confidence).toBe("unique");
  });

  it("resolves two classes that share a short name each to the one it names", async () => {
    // Both files declare `Base`, and this signature names both — one bare
    // through `use App\Base\Base`, one through `use App\Dup\Base as DupBase`.
    // By short name alone they were one edge with two candidates, and the
    // best it could say was `multiple-candidates`. Qualified by namespace
    // they are two edges to two classes, and each answers `unique`.
    const found = edgesOf("src/Ambiguous/Ambiguous.php", "Base", "type_reference");
    expect(found).toHaveLength(2);
    const byQualifier = new Map(found.map((e) => [e.calleeQualifier, e]));
    expect(byQualifier.get("\\App\\Base\\")?.calleeCandidates).toEqual(["src/Base/Base.php::Base#5"]);
    expect(byQualifier.get("\\App\\Dup\\")?.calleeCandidates).toEqual(["src/Dup/Base.php::Base#5"]);
    expect(byQualifier.get("\\App\\Dup\\")?.localAlias).toBe("DupBase");
    for (const e of found) expect(e.confidence).toBe("unique");
  });

  it("does not let the duplicate short name turn a single-candidate edge ambiguous", async () => {
    // The other half of the same question: `src/Dup/Base.php` is not a
    // dependency of `Child.php`, so it must not reach that file's `extends`.
    // The scan is confined to the caller's own imports by construction, and
    // this is what says so.
    expect(edge("src/Child/Child.php", "Base", "type_reference").calleeCandidates)
      .not.toContain("src/Dup/Base.php::Base#5");
  });

  it("leaves no structural edge carrying a namespace as a module specifier", async () => {
    // `sourceModule` routes an edge to a path matcher. A PHP FQCN is not a
    // path, so setting it strands the edge — this is the guard that says the
    // field stayed empty.
    for (const file of graph.outgoingCallsByFile.keys()) {
      if (!file.endsWith(".php")) continue;
      for (const e of graph.outgoingCallsByFile.get(file) ?? []) {
        expect(e.sourceModule, `${file} → ${e.calleeName}`).toBeUndefined();
      }
    }
  });
});

/**
 * A declaration behind an attribute, at the real `buildCodeGraph` +
 * `resolveCallSites` level (issue #205).
 *
 * The file-level dependency graph was never affected: `use` and `require`
 * resolution reads imports, not declarations. What broke is the symbol graph
 * the class declaration is registered under — filed as `ObservedBy`, nothing
 * named `Post` exists for the observer's type hint to resolve against, so the
 * edge that file-mode `codebase_impact` derives its reverse index from has no
 * target and the class has no dependents. Only the name may move here: the
 * declaration's range — attributes included — and every edge stay as they are.
 */
describe("PHP declarations behind an attribute", () => {
  let root: string;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  const edge = (file: string, name: string, kind: SymbolEdge["kind"]): SymbolEdge => {
    const found = (graph.outgoingCallsByFile.get(file) ?? []).filter(
      (e) => e.calleeName === name && e.kind === kind,
    );
    expect(found, `expected one ${kind} edge to ${name} in ${file}`).toHaveLength(1);
    return found[0];
  };

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "socraticode-php-attr-"));
    write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));

    // The report's repro shape: the attribute carries arguments of its own,
    // so `ObservedBy`, the attribute's name, is the first `name` in the
    // declaration and `PostObserver`, inside its arguments, the second —
    // either would be wrong for a class called `Post`.
    write("src/Models/Post.php", `<?php

namespace App\\Models;

#[ObservedBy([PostObserver::class])]
class Post
{
    public function author() {}
}
`);

    write("src/Observers/PostObserver.php", `<?php

namespace App\\Observers;

use App\\Models\\Post;

class PostObserver
{
    public function updated(Post $post): void
    {
        $post->author();
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
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("records an attributed class under its own name, not the attribute's", () => {
    const syms = graph.symbolsByFile.get("src/Models/Post.php") ?? [];
    // The id pins the declaration's range too: line 5 is the attribute, which
    // is where the declaration has always started.
    expect(syms.filter((s) => s.kind === "class").map((s) => [s.name, s.id]))
      .toEqual([["Post", "src/Models/Post.php::Post#5"]]);
    // Neither `name` the declaration holds — the attribute's own nor the one
    // inside its arguments — may be filed as a symbol of this file.
    const names = syms.map((s) => s.name);
    expect(names).not.toContain("ObservedBy");
    expect(names).not.toContain("PostObserver");
  });

  it("resolves a reference to the class under the name the source writes", () => {
    // The dependents file-mode `codebase_impact` reports come from exactly
    // this edge: resolved, it puts PostObserver.php in Post's reverse index.
    const e = edge("src/Observers/PostObserver.php", "Post", "type_reference");
    expect(e.calleeCandidates).toEqual(["src/Models/Post.php::Post#5"]);
    expect(e.confidence).toBe("unique");
  });
});
