import { describe, expect, it } from "vitest";
import * as path from "path";
import { safeToString } from "src/setting/infra/gitlabApiClient";
import { sanitizeVaultTargetPath } from "src/setting/policy/providerBootstrapPolicy";

describe("safeToString", () => {
    it("handles primitives", () => {
        expect(safeToString(null)).toBe("null");
        expect(safeToString(undefined)).toBe("undefined");
        expect(safeToString("foo")).toBe("foo");
        expect(safeToString(123)).toBe("123");
        expect(safeToString(true)).toBe("true");
        expect(safeToString(BigInt(123))).toBe("123");
        const sym = Symbol("desc");
        expect(safeToString(sym)).toContain("Symbol");
    });

    it("stringifies objects and arrays", () => {
        expect(safeToString({ a: 1 })).toBe(JSON.stringify({ a: 1 }));
        expect(safeToString([1, "a"]) ).toBe(JSON.stringify([1, "a"]));
    });

    it("returns (unserializable) for circular objects", () => {
        const obj: Record<string, unknown> = {};
        obj["self"] = obj;
        expect(safeToString(obj)).toBe("(unserializable)");
    });
});

describe("sanitizeVaultTargetPath (exported)", () => {
    const parent = path.resolve(process.cwd());

    it("rejects whitespace-only input", () => {
        expect(sanitizeVaultTargetPath("   ", parent)).toBeNull();
    });

    it("rejects traversal tokens", () => {
        const traversal = ".." + path.sep + "etc";
        expect(sanitizeVaultTargetPath(traversal, parent)).toBeNull();
    });

    it("accepts a valid relative path inside parent", () => {
        const res = sanitizeVaultTargetPath("myvault", parent);
        expect(res).not.toBeNull();
        expect(res).toBe(path.join(parent, "myvault"));
        expect(res!.startsWith(parent)).toBe(true);
    });

    it("accepts a safe absolute path", () => {
        const root = path.parse(process.cwd()).root;
        const abs = path.join(root, "tmp", "somevault");
        // Should be valid as segments are safe
        expect(sanitizeVaultTargetPath(abs, parent)).not.toBeNull();
    });

    it("rejects empty string", () => {
        expect(sanitizeVaultTargetPath("", parent)).toBeNull();
    });

    it("rejects nested traversal pattern foo/../../bar", () => {
        expect(sanitizeVaultTargetPath("foo/../../bar", parent)).toBeNull();
    });

    it("rejects input containing embedded null bytes", () => {
        expect(sanitizeVaultTargetPath("safe\u0000bad", parent)).toBeNull();
    });

    it("accepts foo//bar normalizing consecutive separators", () => {
        const res = sanitizeVaultTargetPath("foo//bar", parent);
        expect(res).not.toBeNull();
        expect(res).toBe(path.join(parent, "foo", "bar"));
    });
});
