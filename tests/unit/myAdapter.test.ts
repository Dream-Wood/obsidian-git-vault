import { describe, expect, it, vi } from "vitest";
import { MyAdapter, toOwnedArrayBuffer } from "../../src/gitManager/myAdapter";
import type ObsidianGit from "../../src/main";

describe("toOwnedArrayBuffer", () => {
    it("copies exactly the visible bytes of an offset typed-array view", () => {
        const source = new Uint8Array([99, 1, 2, 3, 88]);
        const result = toOwnedArrayBuffer(source.subarray(1, 4));

        source[1] = 42;

        expect(result.byteLength).toBe(3);
        expect([...new Uint8Array(result)]).toEqual([1, 2, 3]);
    });
});

describe("MyAdapter.writeFile", () => {
    it("passes an owned exact-range ArrayBuffer to Obsidian binary storage", async () => {
        const writeBinary = vi.fn(
            async (_path: string, _data: ArrayBuffer) => undefined
        );
        const vault = {
            adapter: { writeBinary },
            getAbstractFileByPath: () => null,
        };
        const plugin = {
            settings: { basePath: "", gitDir: ".git" },
        } as unknown as ObsidianGit;
        const adapter = new MyAdapter(vault as never, plugin);
        const source = new Uint8Array([99, 10, 20, 30, 88]);

        await adapter.writeFile(
            ".git/objects/pack/test.pack",
            source.subarray(1, 4)
        );

        const written = writeBinary.mock.calls[0][1] as ArrayBuffer;
        expect(written).toBeInstanceOf(ArrayBuffer);
        expect(written.byteLength).toBe(3);
        expect([...new Uint8Array(written)]).toEqual([10, 20, 30]);
    });
});
