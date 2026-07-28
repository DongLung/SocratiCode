// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DETECT_HEAD_BYTES, detectExtensionlessExtension } from "../../src/constants.js";
import {
  detectExtensionFromSource,
  readFileHead,
  resolveExtensionlessExtension,
  resolveExtensionlessExtensionStrict,
} from "../../src/services/extensionless.js";
import { canTestPermissionDenied } from "../helpers/fixtures.js";

describe("extensionless I/O helpers", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-extless-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const write = (name: string, content: string | Buffer): string => {
    const p = path.join(root, name);
    fs.writeFileSync(p, content);
    return p;
  };

  describe("readFileHead", () => {
    it("reads at most maxBytes and decodes utf-8", async () => {
      const p = write("big", "x".repeat(20000));
      const head = await readFileHead(p, 8192);
      expect(head.length).toBe(8192);
    });
    it("throws for a missing file", async () => {
      await expect(readFileHead(path.join(root, "nope"))).rejects.toThrow();
    });
    it.skipIf(process.platform === "win32")("rejects a FIFO without blocking on the open", async () => {
      // O_NONBLOCK + fstat must reject a FIFO immediately instead of blocking on
      // open("r"), independent of any lstat guard in the caller.
      const fifo = path.join(root, "rfh-pipe");
      execFileSync("mkfifo", [fifo]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            readFileHead(fifo),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("blocked on FIFO open")), 2000);
            }),
          ]),
        ).rejects.toThrow(/not a regular file/);
      } finally {
        clearTimeout(timer);
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("resolveExtensionlessExtension", () => {
    it("detects a bash probe as .sh", async () => {
      const p = write("strato-check", "#!/bin/bash\nexit 0\n");
      expect(await resolveExtensionlessExtension(p)).toBe(".sh");
    });
    it("returns null for a non-code extensionless file", async () => {
      const p = write("LICENSE", "MIT License\n\nCopyright (c) 2026\n");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("returns null for a binary file (NUL byte)", async () => {
      const p = write("blob", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("returns null on read error (missing file)", async () => {
      expect(await resolveExtensionlessExtension(path.join(root, "gone"))).toBeNull();
    });
    it("returns null when the kill-switch is off", async () => {
      const p = write("probe", "#!/bin/bash\n");
      vi.stubEnv("INDEX_EXTENSIONLESS", "false");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it("never runs detection on a SPECIAL_FILE (Makefile) even with code-like content", async () => {
      // Makefiles/Dockerfiles are extensionless but handled by name elsewhere;
      // a shell-recipe Makefile would otherwise sniff as .sh and pollute the
      // graph. It must stay out of content detection here.
      const p = write("Makefile", "build:\n\tset -euo pipefail\n\tif [ -f foo ]; then \\\n\t\techo yes; \\\n\tfi\n");
      expect(await resolveExtensionlessExtension(p)).toBeNull();
    });
    it.skipIf(process.platform === "win32")("returns null for a FIFO without blocking on the open", async () => {
      // glob({nodir:true}) still yields FIFOs/sockets/devices, and opening a FIFO
      // for read blocks until a writer appears — which would wedge the whole scan.
      // Detection must lstat and drop non-regular files, never head-read them.
      const fifo = path.join(root, "mypipe");
      execFileSync("mkfifo", [fifo]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          resolveExtensionlessExtension(fifo),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("blocked on FIFO open")), 2000);
          }),
        ]);
        expect(result).toBeNull();
      } finally {
        clearTimeout(timer);
        // If a buggy impl left a read-open blocked, open the write end to release
        // it so the leaked threadpool op does not stall worker teardown.
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {
          /* no blocked reader (guard worked) → ENXIO; ignore */
        }
      }
    });
  });

  describe("resolveExtensionlessExtensionStrict", () => {
    it("throws on a read failure instead of returning null (unlike the lenient variant)", async () => {
      const missing = path.join(root, "gone");
      await expect(resolveExtensionlessExtensionStrict(missing)).rejects.toThrow();
      // The lenient variant swallows the same failure and returns null.
      expect(await resolveExtensionlessExtension(missing)).toBeNull();
    });
    it("returns null (no throw) for a readable non-code file", async () => {
      const p = write("NOTICE", "All rights reserved.\n");
      expect(await resolveExtensionlessExtensionStrict(p)).toBeNull();
    });
    it("returns the detected extension for a readable script", async () => {
      const p = write("probe", "#!/bin/bash\nexit 0\n");
      expect(await resolveExtensionlessExtensionStrict(p)).toBe(".sh");
    });
    it.skipIf(!canTestPermissionDenied)(
      "throws on a head-read failure (EACCES), distinct from a stat failure",
      async () => {
        // The stat-failure path is covered above (missing file → lstat throws).
        // This pins the *read*-failure path: a regular file that opens with EACCES
        // must still throw (not collapse to null), or the incremental purge guard
        // silently regresses.
        const p = write("secret", "#!/bin/bash\nexit 0\n");
        fs.chmodSync(p, 0o000);
        try {
          await expect(resolveExtensionlessExtensionStrict(p)).rejects.toThrow();
          // The lenient variant swallows the same read failure and returns null.
          expect(await resolveExtensionlessExtension(p)).toBeNull();
        } finally {
          fs.chmodSync(p, 0o644);
        }
      },
    );
  });

  describe("detectExtensionFromSource", () => {
    it("detects a shebang script", () => {
      expect(detectExtensionFromSource("#!/bin/bash\nexit 0\n")).toBe(".sh");
    });
    it("detects Python by content sniff", () => {
      expect(detectExtensionFromSource("def configure(conf):\n    return 1\n")).toBe(".py");
    });
    it("returns null for prose", () => {
      expect(detectExtensionFromSource("All rights reserved.\n")).toBeNull();
    });
    it("returns null for content containing a NUL byte", () => {
      expect(detectExtensionFromSource(`abc${String.fromCharCode(0)}def`)).toBeNull();
    });
    it("scores an 8192-BYTE head, not an 8192-character one", async () => {
      // "é" is 1 character but 2 UTF-8 bytes. 5000 of them is 10000 bytes — past
      // the 8192-byte head — while being only ~5003 characters, so a character
      // slice would reach the shell markers below and score them.
      const padding = `# ${"é".repeat(5000)}\n`;
      const source = `${padding}if [ -d /tmp ]; then\n  export PATH=/bin\nfi\n`;

      // Byte window: the head is all padding, so nothing is detected.
      expect(detectExtensionFromSource(source)).toBeNull();

      // Sanity check that the markers WOULD score if they were in the window —
      // otherwise this test would pass for the wrong reason.
      expect(detectExtensionFromSource("if [ -d /tmp ]; then\n  export PATH=/bin\nfi\n")).toBe(".sh");

      // And in-memory detection agrees with the on-disk reader on the same bytes.
      const p = write("wide", source);
      expect(await resolveExtensionlessExtensionStrict(p)).toBeNull();
    });
    it("narrows the window for lossily-decoded content, on disk as well as in memory", async () => {
      // Latin-1 bytes are invalid UTF-8, so each decodes to U+FFFD and re-encodes
      // to three bytes: a head of them fills the byte window in a third of the
      // characters, leaving the shell markers after the padding outside it — even
      // though the whole file fits inside the raw head the disk reader takes.
      const padBytes = Math.ceil(DETECT_HEAD_BYTES / 3) + 100;
      const markers = "\nif [ -d /tmp ]; then\n  export PATH=/bin\nfi\n";
      const latin1 = Buffer.concat([
        Buffer.from("# "),
        Buffer.alloc(padBytes, 0xe9),
        Buffer.from(markers),
      ]);
      expect(latin1.length).toBeLessThan(DETECT_HEAD_BYTES);
      const p = write("latin1", latin1);

      // Scoring the raw decoded head reaches the markers, so the two windows
      // genuinely diverge here and the assertions below are not a dead fixture.
      expect(detectExtensionlessExtension(await readFileHead(p))).toBe(".sh");

      // The helper's window stops short of them, and the disk-side resolver routes
      // through the helper, so both sides answer "not code" rather than disagreeing.
      expect(detectExtensionFromSource(await readFileHead(p))).toBeNull();
      expect(await resolveExtensionlessExtensionStrict(p)).toBeNull();
      expect(detectExtensionFromSource(fs.readFileSync(p, "utf-8"))).toBeNull();

      // Same length, same markers, valid UTF-8: still detected, so it is the lossy
      // decode that moves the window and not the padding length.
      const ascii = Buffer.concat([
        Buffer.from("# "),
        Buffer.alloc(padBytes, 0x61),
        Buffer.from(markers),
      ]);
      expect(await resolveExtensionlessExtensionStrict(write("ascii", ascii))).toBe(".sh");
    });
  });
});
