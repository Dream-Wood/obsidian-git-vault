import { describe, expect, it, vi } from "vitest";
import { ForgejoGitSyncProvider } from "../../src/syncProvider/forgejoGitSyncProvider";
import type {
    ForgejoGitTransaction,
    ForgejoGitTransport,
} from "../../src/syncProvider/forgejoGitTransport";
import type { ForgejoSnapshot } from "../../src/syncProvider/forgejoThreeWayMerge";
import { DEFAULT_SETTINGS } from "../../src/constants";
import type ObsidianGit from "../../src/main";

const encode = (value: string) => new TextEncoder().encode(value);

function fakeTransport(remote: ForgejoSnapshot = new Map()) {
    const calls = {
        fetch: vi.fn(async () => "remote-oid"),
        commit: vi.fn(async () => "commit-oid"),
        push: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
    };
    const transport: ForgejoGitTransport = {
        kind: "native",
        init: vi.fn(async () => undefined),
        fetch: calls.fetch,
        readBaseOid: vi.fn(async () => null),
        readSnapshot: vi.fn(async (ref) =>
            ref === "remote-oid" ? remote : new Map()
        ),
        listBranches: vi.fn(async () => ["main"]),
        begin: vi.fn(
            async (): Promise<ForgejoGitTransaction> => ({
                originalHead: null,
                originalBase: null,
            })
        ),
        stage: vi.fn(async () => undefined),
        commit: calls.commit,
        push: calls.push,
        updateBase: vi.fn(async () => undefined),
        rollback: calls.rollback,
    };
    return { transport, calls };
}

function fakePlugin(initial = "local\n") {
    let content = encode(initial);
    const adapter = {
        exists: vi.fn(async (path: string) => path === "note.md"),
        mkdir: vi.fn(async () => undefined),
        writeBinary: vi.fn(async (_path: string, value: ArrayBuffer) => {
            content = new Uint8Array(value);
        }),
        remove: vi.fn(async () => {
            content = new Uint8Array();
        }),
    };
    const plugin = {
        settings: {
            ...DEFAULT_SETTINGS,
            activeSyncProvider: "gitea",
            giteaBaseUrl: "https://forge.example",
            giteaOwner: "owner",
            giteaRepo: "repo",
            giteaBranch: "main",
            apiEncryptionEnabled: false,
            syncExcludePaths: [],
            trackedDirectory: "",
            basePath: "",
        },
        app: {
            vault: {
                getFiles: () => [{ path: "note.md" }],
                readBinary: async () => content.slice().buffer,
                adapter,
            },
        },
        gitManager: {
            getRelativeRepoPath: (path: string) => path,
            getRelativeVaultPath: (path: string) => path,
        },
        runWithSuppressedVaultChangeEffects: async (
            action: () => Promise<void>
        ) => action(),
        syncState: {
            getState: () => ({
                pendingChanges: [],
                conflicts: [],
                lastSyncTime: null,
            }),
        },
        state: { offlineMode: false },
        localStorage: { getHostname: () => "test-device" },
        saveSettings: vi.fn(async () => undefined),
        showNotice: vi.fn(),
    };
    return {
        plugin: plugin as unknown as ObsidianGit,
        adapter,
        getContent: () => new TextDecoder().decode(content),
    };
}

describe("ForgejoGitSyncProvider transaction", () => {
    it("uses exactly one fetch, one commit, and one push", async () => {
        const { plugin } = fakePlugin();
        const { transport, calls } = fakeTransport();
        const provider = new ForgejoGitSyncProvider(plugin, transport);

        const result = await provider.sync();

        expect(result.success).toBe(true);
        expect(calls.fetch).toHaveBeenCalledTimes(1);
        expect(calls.commit).toHaveBeenCalledTimes(1);
        expect(calls.push).toHaveBeenCalledTimes(1);
    });

    it("rolls the local file and refs back when push fails", async () => {
        const { plugin, getContent } = fakePlugin();
        const { transport, calls } = fakeTransport(
            new Map([["remote.md", encode("remote\n")]])
        );
        calls.push.mockRejectedValueOnce(new Error("rejected"));
        const provider = new ForgejoGitSyncProvider(plugin, transport);

        await expect(provider.sync()).rejects.toThrow("rejected");
        expect(getContent()).toBe("local\n");
        expect(calls.rollback).toHaveBeenCalledTimes(1);
    });

    it("does not write, commit, or push when a real conflict is found", async () => {
        const { plugin, adapter } = fakePlugin("local\n");
        const { transport, calls } = fakeTransport(
            new Map([["note.md", encode("remote\n")]])
        );
        const provider = new ForgejoGitSyncProvider(plugin, transport);

        const result = await provider.sync();

        expect(result.conflicts).toHaveLength(1);
        expect(adapter.writeBinary).not.toHaveBeenCalled();
        expect(calls.commit).not.toHaveBeenCalled();
        expect(calls.push).not.toHaveBeenCalled();
    });

    it("rebuilds the isolated mobile cache and retries the full remote read once", async () => {
        const { plugin } = fakePlugin("local\n");
        const { transport, calls } = fakeTransport(
            new Map([["note.md", encode("local\n")]])
        );
        const repairCorruptedCache = vi.fn(async () => undefined);
        transport.repairCorruptedCache = repairCorruptedCache;
        const readSnapshot = vi
            .fn<(ref: string | null) => Promise<ForgejoSnapshot>>()
            .mockRejectedValueOnce(
                new Error(
                    "Packfile payload corrupted: calculated abc but expected def."
                )
            )
            .mockImplementation(async (ref) =>
                ref === "remote-oid"
                    ? new Map([["note.md", encode("local\n")]])
                    : new Map()
            );
        transport.readSnapshot = readSnapshot;
        const provider = new ForgejoGitSyncProvider(plugin, transport);

        const result = await provider.sync();

        expect(result.success).toBe(true);
        expect(repairCorruptedCache).toHaveBeenCalledOnce();
        expect(calls.fetch).toHaveBeenCalledTimes(2);
    });
});
