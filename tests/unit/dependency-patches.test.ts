// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { Address4, Address6, AddressError } from "ip-address";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const expand = require("brace-expansion") as (pattern: string) => string[];

describe("transitive dependency security patches", () => {
  describe("brace-expansion", () => {
    it("preserves nested alternatives and file-extension expansion used by glob", () => {
      expect(expand("src/{a,{b,c}}.{ts,js}")).toEqual([
        "src/a.ts",
        "src/a.js",
        "src/b.ts",
        "src/b.js",
        "src/c.ts",
        "src/c.js",
      ]);
    });

    it.each([
      ["comma-group recursion", "'{' + '{a},'.repeat(7000) + 'b}'", 7001],
      ["argument-array stack exhaustion", "'{{x},' + 'a,'.repeat(125000) + 'b}'", 100000],
      ["nested expansion recursion", "'{'.repeat(3200) + 'a,b' + '}'.repeat(3200)", 1],
      ["quadratic rewrite", "'{a}' + '}'.repeat(64000) + ',z}'", 1],
    ])("bounds %s without crashing or blocking the caller", (_name, expression, length) => {
      // Published denial-of-service inputs run in a bounded child so a dependency
      // regression cannot hang the test runner or terminate its process.
      const result = execFileSync(
        process.execPath,
        [
          "-e",
          `const expand = require('brace-expansion');
           process.stdout.write(String(expand(${expression}).length));`,
        ],
        { cwd: process.cwd(), timeout: 5000, encoding: "utf8" },
      );
      expect(result).toBe(String(length));
    });
  });

  describe("ip-address", () => {
    it("never treats matching prefix bits from different address families as subnet membership", () => {
      const v6Host = new Address6("a00::1");
      const v4Subnet = new Address4("10.0.0.0/8");
      const v4Host = new Address4("32.1.13.184");
      const v6Subnet = new Address6("2001:db8::/32");
      expect(v6Host.isInSubnet(v4Subnet)).toBe(false);
      expect(v6Host.isHostInSubnet(v4Subnet)).toBe(false);
      expect(v4Host.isInSubnet(v6Subnet)).toBe(false);
      expect(v4Host.isHostInSubnet(v6Subnet)).toBe(false);
    });

    it("preserves same-family membership and explicit IPv4-mapped conversions", () => {
      const subnet = new Address4("10.0.0.0/8");
      expect(new Address4("10.0.0.1").isInSubnet(subnet)).toBe(true);
      expect(new Address4("192.0.2.1").isInSubnet(subnet)).toBe(false);
      expect(new Address6("2001:db8::1").isInSubnet(new Address6("2001:db8::/32"))).toBe(
        true,
      );
      expect(new Address6("::ffff:10.0.0.1").to4().isInSubnet(subnet)).toBe(true);
    });

    it("still accepts maximum-length addresses with their CIDR and zone suffixes", () => {
      expect(Address4.isValid("255.255.255.255/32")).toBe(true);
      expect(Address6.isValid("ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255%eth0/128")).toBe(
        true,
      );
    });

    it.each([
      ["IPv4", Address4],
      ["IPv6", Address6],
    ] as const)("rejects oversized %s input with bounded diagnostics", (_name, Address) => {
      expect.assertions(3);
      try {
        new Address("!".repeat(10000));
      } catch (error) {
        expect(error).toBeInstanceOf(AddressError);
        expect((error as AddressError).message.length).toBeLessThan(128);
        expect(((error as AddressError).parseMessage ?? "").length).toBeLessThan(128);
      }
    });
  });
});
