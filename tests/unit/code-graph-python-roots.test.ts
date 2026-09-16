// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";

interface ProjectFixture {
  root: string;
  cleanup(): void;
}

function createProject(files: Record<string, string>): ProjectFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-python-roots-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content);
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("configured Python import roots", () => {
  let project: ProjectFixture | undefined;

  afterEach(() => {
    project?.cleanup();
    project = undefined;
  });

  const hasEdge = (
    graph: Awaited<ReturnType<typeof buildCodeGraph>>,
    source: string,
    target: string,
  ): boolean => graph.edges.some((edge) => edge.source === source && edge.target === target);

  it("builds the Airflow dags dependency through an explicit project root", async () => {
    project = createProject({
      ".socraticode.json": JSON.stringify({ pythonRoots: ["dags"] }),
      "dags/etl/config.py": "def dw_engine():\n    return 1\n",
      "dags/etl/cache.py":
        "from etl.config import dw_engine\n\ndef run():\n    return dw_engine()\n",
    });

    const graph = await buildCodeGraph(project.root);

    expect(hasEdge(graph, "dags/etl/cache.py", "dags/etl/config.py")).toBe(true);
  });

  it("preserves project-root, src, and manifest resolution without the setting", async () => {
    project = createProject({
      "rootpkg/config.py": "value = 1\n",
      "rootpkg/cache.py": "from rootpkg.config import value\n",
      "src/srcpkg/config.py": "value = 2\n",
      "src/srcpkg/cache.py": "from srcpkg.config import value\n",
      "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/pkg/pyproject.toml": '[project]\nname = "pkg"\n',
      "packages/pkg/src/manifestpkg/config.py": "value = 3\n",
      "packages/pkg/src/manifestpkg/cache.py": "from manifestpkg.config import value\n",
    });

    const graph = await buildCodeGraph(project.root);

    expect(hasEdge(graph, "rootpkg/cache.py", "rootpkg/config.py")).toBe(true);
    expect(hasEdge(graph, "src/srcpkg/cache.py", "src/srcpkg/config.py")).toBe(true);
    expect(
      hasEdge(
        graph,
        "packages/pkg/src/manifestpkg/cache.py",
        "packages/pkg/src/manifestpkg/config.py",
      ),
    ).toBe(true);
  });

  it("ignores unusable roots without fabricating an edge", async () => {
    project = createProject({
      ".socraticode.json": JSON.stringify({
        pythonRoots: ["../outside", "missing", "dags/etl/config.py"],
      }),
      "dags/etl/config.py": "value = 1\n",
      "dags/etl/cache.py": "from etl.config import value\n",
      "rootpkg/config.py": "value = 2\n",
      "rootpkg/cache.py": "from rootpkg.config import value\n",
    });

    const graph = await buildCodeGraph(project.root);

    expect(hasEdge(graph, "dags/etl/cache.py", "dags/etl/config.py")).toBe(false);
    expect(hasEdge(graph, "rootpkg/cache.py", "rootpkg/config.py")).toBe(true);
  });

  it("uses declared root order before manifest-derived roots", async () => {
    project = createProject({
      ".socraticode.json": JSON.stringify({
        pythonRoots: ["custom-b", "custom-a"],
      }),
      "pyproject.toml": '[tool.uv.workspace]\nmembers = ["packages/*"]\n',
      "packages/pkg/pyproject.toml": '[project]\nname = "pkg"\n',
      "packages/pkg/src/shared/config.py": "value = 'manifest'\n",
      "custom-a/shared/config.py": "value = 'a'\n",
      "custom-b/shared/config.py": "value = 'b'\n",
      "app/cache.py": "from shared.config import value\n",
    });

    const graph = await buildCodeGraph(project.root);

    expect(hasEdge(graph, "app/cache.py", "custom-b/shared/config.py")).toBe(true);
    expect(hasEdge(graph, "app/cache.py", "custom-a/shared/config.py")).toBe(false);
    expect(hasEdge(graph, "app/cache.py", "packages/pkg/src/shared/config.py")).toBe(false);
  });
});
