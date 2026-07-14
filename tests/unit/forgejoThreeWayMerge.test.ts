import { describe, expect, it } from "vitest";
import {
    mergeForgejoSnapshots,
    type ForgejoSnapshot,
} from "../../src/syncProvider/forgejoThreeWayMerge";
import {
    buildForgejoCommitAuthor,
    buildForgejoRemoteUrl,
    isPackfileCorruptionError,
    isForgejoSyncPath,
} from "../../src/syncProvider/forgejoGitTransport";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;
const snapshot = (files: Record<string, string>): ForgejoSnapshot =>
    new Map(
        Object.entries(files).map(([path, value]) => [path, encode(value)])
    );

describe("Forgejo three-way merge", () => {
    it("keeps independent local and remote edits in one merged file", () => {
        const result = mergeForgejoSnapshots(
            snapshot({ "note.md": "one\ntwo\nthree\n" }),
            snapshot({ "note.md": "ONE\ntwo\nthree\n" }),
            snapshot({ "note.md": "one\ntwo\nTHREE\n" })
        );

        expect(result.conflicts).toEqual([]);
        expect(decode(result.merged.get("note.md"))).toBe("ONE\ntwo\nTHREE\n");
    });

    it("surfaces overlapping edits with base, local, and remote content", () => {
        const result = mergeForgejoSnapshots(
            snapshot({ "note.md": "base\n" }),
            snapshot({ "note.md": "local\n" }),
            snapshot({ "note.md": "remote\n" })
        );

        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]).toMatchObject({
            path: "note.md",
            baseContent: "base\n",
            localContent: "local\n",
            remoteContent: "remote\n",
        });
    });

    it("handles deletes using the common ancestor instead of mtimes", () => {
        const result = mergeForgejoSnapshots(
            snapshot({ "deleted.md": "old", "remote.md": "old" }),
            snapshot({ "remote.md": "old" }),
            snapshot({ "deleted.md": "old", "remote.md": "new" })
        );

        expect(result.conflicts).toEqual([]);
        expect(result.merged.has("deleted.md")).toBe(false);
        expect(decode(result.merged.get("remote.md"))).toBe("new");
    });

    it("does not silently combine different initial versions", () => {
        const result = mergeForgejoSnapshots(
            null,
            snapshot({ "note.md": "local" }),
            snapshot({ "note.md": "remote" })
        );
        expect(result.conflicts).toHaveLength(1);
    });
});

describe("Forgejo Git target safety", () => {
    it("builds a credential-free encoded clone URL", () => {
        expect(
            buildForgejoRemoteUrl(
                "https://forge.example/",
                "my team",
                "vault docs"
            )
        ).toBe("https://forge.example/my%20team/vault%20docs.git");
    });

    it("hard-excludes Obsidian, Git, and code-index internals", () => {
        expect(isForgejoSyncPath("note.md")).toBe(true);
        expect(isForgejoSyncPath(".obsidian/workspace.json")).toBe(false);
        expect(isForgejoSyncPath(".git/index")).toBe(false);
        expect(isForgejoSyncPath(".cocoindex_code/db")).toBe(false);
    });

    it("recognizes mobile packfile corruption that requires cache rebuild", () => {
        expect(
            isPackfileCorruptionError(
                new Error(
                    "Packfile payload corrupted: calculated abc but expected def."
                )
            )
        ).toBe(true);
        expect(
            isPackfileCorruptionError(new Error("Authentication failed"))
        ).toBe(false);
    });

    it("always provides a stable mobile commit author", () => {
        expect(
            buildForgejoCommitAuthor({
                configuredName: "Vault Author",
                configuredEmail: "author@example.com",
                owner: "forgejo-owner",
            })
        ).toEqual({
            name: "Vault Author",
            email: "author@example.com",
        });
        expect(
            buildForgejoCommitAuthor({
                owner: "Forgejo Team",
                hostname: "Android Phone",
            })
        ).toEqual({
            name: "Forgejo Team",
            email: "forgejo-team@git-vault.local",
        });
    });
});
