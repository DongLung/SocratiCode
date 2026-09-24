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
 * PHP qualified calls and class references through the real `buildCodeGraph`
 * + `resolveCallSites` pass.
 *
 * The extractor tests prove the qualifier is written; the resolver tests prove
 * it is matched. Only a real build proves both meet on the symbols a real
 * extraction produces, with the dependencies the file graph actually draws.
 * The two reproductions from the issue are here as filed, and a controller
 * that declares a `capture()` of its own calls four other `capture()`s — one
 * of them on a class the project does not have.
 */
describe("PHP qualified edges in a real graph", () => {
  let root: string;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };

  const CONTROLLER = "src/Http/Controller.php";

  /** The single edge `caller` emits under one name and kind, failing loudly if there is not exactly one. */
  const edgeFrom = (file: string, caller: string, name: string, kind: SymbolEdge["kind"] = "call"): SymbolEdge => {
    const found = (graph.outgoingCallsByFile.get(file) ?? [])
      .filter((e) => e.callerId.includes(`::${caller}#`) && e.calleeName === name && e.kind === kind);
    expect(found, `expected one ${kind} edge to ${name} from ${caller} in ${file}`).toHaveLength(1);
    return found[0];
  };

  /** The id of the one symbol `file` declares under `name`, owned by `owner`. */
  const idOf = (file: string, name: string, owner: string): string => {
    const found = (graph.symbolsByFile.get(file) ?? []).filter((s) => s.name === name && s.phpOwner === owner);
    expect(found, `expected one ${name} owned by ${owner} in ${file}`).toHaveLength(1);
    return found[0].id;
  };

  /** Every edge in the graph that resolves into `file`. */
  const into = (file: string): SymbolEdge[] =>
    [...graph.outgoingCallsByFile.values()]
      .flat()
      .filter((e) => (e.calleeCandidates ?? []).some((id) => id.startsWith(`${file}::`)));

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "socraticode-php-qualifiers-"));
    write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));

    // Two classes with a same-named static method, both reachable from the
    // controller, and a third named `Request` that is not Illuminate's.
    for (const cls of ["Invoice", "Order", "Request"]) {
      write(`src/Models/${cls}.php`, `<?php

namespace App\\Models;

class ${cls}
{
    public static function capture(): void
    {
    }
}
`);
    }

    write(CONTROLLER, `<?php

namespace App\\Http;

use Illuminate\\Http\\Request;
use App\\Models\\Invoice;
use App\\Models\\Invoice as Bill;
use App\\Models\\Order;
use App\\Models\\Request as RequestModel;

class Controller
{
    public function capture(): void
    {
    }

    public function external(): void
    {
        Request::capture();
    }

    public function bill(): void
    {
        Invoice::capture();
    }

    public function viaAlias(): void
    {
        Bill::capture();
    }

    public function viaFqcn(): void
    {
        \\App\\Models\\Order::capture();
    }

    public function viaRelative(): void
    {
        namespace\\Local::build();
    }

    public function hinted(\\Illuminate\\Http\\Request $r, RequestModel $m): void
    {
    }

    public function made(): void
    {
        new \\App\\Models\\Order();
    }
}

class Base
{
}

class Local extends namespace\\Base
{
    public static function build(): void
    {
    }
}
`);

    // The issue's self-edge reproduction, as filed: three schemas in one
    // namespace, none imported, so the file graph draws no edge between them.
    for (const cls of ["UserSchema", "OrderSchema"]) {
      write(`src/Schema/${cls}.php`, `<?php

namespace App\\Schema;

class ${cls}
{
    public static function all(): array
    {
        return [];
    }
}
`);
    }
    write("src/Schema/Schema.php", `<?php

namespace App\\Schema;

class Schema
{
    public static function all(): array
    {
        return array_merge(
            UserSchema::all(),
            OrderSchema::all(),
        );
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

  describe("static calls", () => {
    it("leaves a call to a class the project does not have unresolved", () => {
      // `Request` is Illuminate's, while the project's own
      // `App\Models\Request::capture()` is reachable and the caller declares a
      // `capture()` of its own: two wrong answers the name alone could give.
      expect(graph.edges.some((e) => e.source === CONTROLLER && e.target === "src/Models/Request.php")).toBe(true);
      const edge = edgeFrom(CONTROLLER, "external", "capture");
      expect(edge.calleeQualifier).toBe("\\Illuminate\\Http\\Request");
      expect(edge.calleeCandidates).toEqual([]);
      expect(edge.confidence).toBe("unresolved");
    });

    it("resolves a call to the method of the class it names, not the caller's own", () => {
      // The controller declares `capture()` too. Matched by name, this was a
      // `local` self-edge.
      const edge = edgeFrom(CONTROLLER, "bill", "capture");
      expect(edge.calleeCandidates).toEqual([idOf("src/Models/Invoice.php", "capture", "\\App\\Models\\Invoice")]);
      expect(edge.confidence).toBe("unique");
    });

    it("resolves an aliased class as the class the alias names", () => {
      const edge = edgeFrom(CONTROLLER, "viaAlias", "capture");
      expect(edge.calleeCandidates).toEqual([idOf("src/Models/Invoice.php", "capture", "\\App\\Models\\Invoice")]);
    });

    it("resolves a fully qualified class, and picks it out of two same-named methods", () => {
      const edge = edgeFrom(CONTROLLER, "viaFqcn", "capture");
      expect(edge.calleeCandidates).toEqual([idOf("src/Models/Order.php", "capture", "\\App\\Models\\Order")]);
      expect(edge.confidence).toBe("unique");
    });

    it("resolves a namespace-relative class declared in the caller's own file", () => {
      const edge = edgeFrom(CONTROLLER, "viaRelative", "build");
      expect(edge.calleeCandidates).toEqual([idOf(CONTROLLER, "build", "\\App\\Http\\Local")]);
      expect(edge.confidence).toBe("local");
    });

    it("draws no edge from any of the four calls to the controller's own `capture()`", () => {
      const own = idOf(CONTROLLER, "capture", "\\App\\Http\\Controller");
      expect(into(CONTROLLER).filter((e) => e.calleeCandidates.includes(own))).toEqual([]);
    });
  });

  describe("the issue's self-edge reproduction", () => {
    const SCHEMA = "src/Schema/Schema.php";

    it.each(["UserSchema", "OrderSchema"])("does not answer `%s::all()` with the caller's own `all()`", (cls) => {
      const edge = (graph.outgoingCallsByFile.get(SCHEMA) ?? [])
        .filter((e) => e.calleeName === "all" && e.calleeQualifier === `\\App\\Schema\\${cls}`);
      expect(edge).toHaveLength(1);
      expect(edge[0].calleeCandidates).not.toContain(idOf(SCHEMA, "all", "\\App\\Schema\\Schema"));
      expect(edge[0].confidence).not.toBe("local");
    });

    it.each(["UserSchema", "OrderSchema"])("resolves `%s::all()` to its own class's `all()`", (cls) => {
      // Same namespace and no `use`, so PHP needs no import and the file graph
      // draws no edge to the siblings. The qualified class is found by its
      // exact name all the same.
      expect(graph.edges.filter((e) => e.source === SCHEMA)).toEqual([]);
      const edge = (graph.outgoingCallsByFile.get(SCHEMA) ?? [])
        .filter((e) => e.calleeName === "all" && e.calleeQualifier === `\\App\\Schema\\${cls}`);
      expect(edge).toHaveLength(1);
      expect(edge[0].calleeCandidates).toEqual([idOf(`src/Schema/${cls}.php`, "all", `\\App\\Schema\\${cls}`)]);
      expect(edge[0].confidence).toBe("unique");
    });
  });

  describe("class references", () => {
    it("leaves a type hint to a class the project does not have unresolved", () => {
      // #183's documented limitation: `\Illuminate\Http\Request` resolved to
      // the project's own `Request` by short name.
      const edge = (graph.outgoingCallsByFile.get(CONTROLLER) ?? [])
        .filter((e) => e.kind === "type_reference" && e.calleeQualifier === "\\Illuminate\\Http\\");
      expect(edge).toHaveLength(1);
      expect(edge[0].calleeCandidates).toEqual([]);
      expect(edge[0].confidence).toBe("unresolved");
    });

    it("resolves a namespace-relative parent declared in the caller's own file", () => {
      const edge = edgeFrom(CONTROLLER, "Local", "Base", "type_reference");
      expect(edge.calleeQualifier).toBe("\\App\\Http\\");
      expect(edge.calleeCandidates).toEqual([idOf(CONTROLLER, "Base", "\\App\\Http\\")]);
      expect(edge.confidence).toBe("local");
    });

    it("resolves `new` on a fully qualified class declared in another file", () => {
      const edge = edgeFrom(CONTROLLER, "made", "Order");
      expect(edge.calleeQualifier).toBe("\\App\\Models\\");
      expect(edge.calleeCandidates).toEqual([idOf("src/Models/Order.php", "Order", "\\App\\Models\\")]);
      expect(edge.confidence).toBe("unique");
    });

    it("resolves a type hint through an alias to the class it names", () => {
      const edge = (graph.outgoingCallsByFile.get(CONTROLLER) ?? [])
        .filter((e) => e.kind === "type_reference" && e.calleeQualifier === "\\App\\Models\\");
      expect(edge).toHaveLength(1);
      expect(edge[0].calleeCandidates).toEqual([idOf("src/Models/Request.php", "Request", "\\App\\Models\\")]);
      expect(edge[0].confidence).toBe("unique");
    });
  });
});

/**
 * The issue's wrong-class reproduction, as filed and in a project of its own:
 * `Request::capture()` names Illuminate's `Request`, and the one `capture()`
 * the controller can reach is `Invoice`'s. Matched by name, the call resolved
 * to it with `unique` confidence.
 */
describe("the issue's wrong-class reproduction, as filed", () => {
  let root: string;
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "socraticode-php-qualifier-repro-"));
    const write = (rel: string, body: string): void => {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    };
    write("composer.json", JSON.stringify({ autoload: { "psr-4": { "App\\": "src/" } } }));
    write("src/Http/Controller.php", `<?php

namespace App\\Http;

use Illuminate\\Http\\Request;
use App\\Models\\Invoice;

class Controller
{
    public function handle(): void
    {
        Request::capture();
    }

    public function bill(Invoice $invoice): void
    {
    }
}
`);
    write("src/Models/Invoice.php", `<?php

namespace App\\Models;

class Invoice
{
    public static function capture(): self
    {
        return new self();
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

  it("reaches `Invoice.php`, so the wrong answer is available to be refused", () => {
    expect(graph.edges.some((e) => e.source === "src/Http/Controller.php" && e.target === "src/Models/Invoice.php"))
      .toBe(true);
  });

  it("leaves `Request::capture()` unresolved instead of answering with `Invoice::capture()`", () => {
    const calls = (graph.outgoingCallsByFile.get("src/Http/Controller.php") ?? [])
      .filter((e) => e.kind === "call" && e.calleeName === "capture");
    expect(calls).toHaveLength(1);
    expect(calls[0].calleeQualifier).toBe("\\Illuminate\\Http\\Request");
    expect(calls[0].calleeCandidates).toEqual([]);
    expect(calls[0].confidence).toBe("unresolved");
  });
});
