// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/**
 * PHP's own identifier case folding, which is ASCII-only.
 *
 * `String.prototype.toLowerCase` is Unicode-aware and PHP is not: `class É {}`
 * followed by `new é()` fails with `Class "é" not found`, while `Widget` and
 * `WIDGET` are the same class. The difference is not academic here, because a
 * non-ASCII character can fold INTO ASCII — `toLowerCase("\u212a")` (KELVIN SIGN) is `"k"` —
 * so a Unicode fold would let an ordinary ASCII reference match an alias
 * declared with a character PHP considers unrelated, drawing an edge the
 * runtime never would.
 *
 * In a module of its own because the extractor and the resolver both need it,
 * and the resolver should not load the whole extractor, and its native parser
 * binding, for one line.
 */
export const phpFoldCase = (name: string): string => name.replace(/[A-Z]+/g, (m) => m.toLowerCase());
