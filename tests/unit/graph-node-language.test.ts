// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { describe, expect, it } from "vitest";
import { nodeLanguage } from "../../src/services/graph-analysis.js";

describe("nodeLanguage", () => {
  it("prefers the language stored on the node", () => {
    expect(nodeLanguage({ language: "shell", relativePath: "scripts/deploy" })).toBe("shell");
  });

  it("falls back to the path extension when no language is stored (extensioned)", () => {
    expect(nodeLanguage({ relativePath: "src/app.ts" })).toBe("typescript");
  });

  it("falls back to plaintext for an extensionless node with no stored language", () => {
    expect(nodeLanguage({ relativePath: "scripts/legacy" })).toBe("plaintext");
  });
});
