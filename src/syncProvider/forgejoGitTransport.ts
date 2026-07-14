import { spawn } from "child_process";
import git from "isomorphic-git";
import { FileSystemAdapter, normalizePath, Platform } from "obsidian";
import * as path from "path";
import { DEFAULT_WIN_GIT_PATH } from "../constants";
import type { IsomorphicGit } from "../gitManager/isomorphicGit";
import type { SimpleGit } from "../gitManager/simpleGit";
import type ObsidianGit from "../main";
import type { ForgejoSnapshot } from "./forgejoThreeWayMerge";

export const FORGEJO_BASE_REF = "refs/git-vault/forgejo-base";

export interface ForgejoGitTransaction {
    originalHead: string | null;
    originalBase: string | null;
    originalIndex?: string | null;
}

export interface ForgejoGitTransport {
    readonly kind: "native" | "isomorphic";
    init(remoteUrl: string, branch: string): Promise<void>;
    fetch(branch: string): Promise<string | null>;
    readBaseOid(): Promise<string | null>;
    readSnapshot(ref: string | null): Promise<ForgejoSnapshot>;
    listBranches(): Promise<string[]>;
    begin(
        remoteOid: string | null,
        branch: string
    ): Promise<ForgejoGitTransaction>;
    stage(paths: string[]): Promise<void>;
    commit(message: string): Promise<string>;
    push(branch: string): Promise<void>;
    updateBase(oid: string): Promise<void>;
    rollback(transaction: ForgejoGitTransaction, branch: string): Promise<void>;
    repairCorruptedCache?(branch: string): Promise<void>;
}

function normalizeGitPath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isReservedPath(value: string): boolean {
    const normalized = normalizeGitPath(value);
    return (
        normalized === ".git" ||
        normalized.startsWith(".git/") ||
        normalized === ".obsidian" ||
        normalized.startsWith(".obsidian/") ||
        normalized === ".cocoindex_code" ||
        normalized.startsWith(".cocoindex_code/")
    );
}

export function isForgejoSyncPath(value: string): boolean {
    return !isReservedPath(value);
}

export function isPackfileCorruptionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /Packfile (?:payload corrupted|trailer mismatch)|Could not read packfile/i.test(
        message
    );
}

export function buildForgejoCommitAuthor({
    repositoryName,
    repositoryEmail,
    configuredName,
    configuredEmail,
    owner,
    hostname,
}: {
    repositoryName?: string | null;
    repositoryEmail?: string | null;
    configuredName?: string | null;
    configuredEmail?: string | null;
    owner?: string | null;
    hostname?: string | null;
}): { name: string; email: string } {
    const firstValue = (...values: Array<string | null | undefined>) =>
        values.map((value) => value?.trim()).find(Boolean);
    const name =
        firstValue(repositoryName, configuredName, owner, hostname) ??
        "Git Vault";
    const explicitEmail = firstValue(repositoryEmail, configuredEmail);
    if (explicitEmail) {
        return { name, email: explicitEmail };
    }

    const localPart =
        firstValue(owner, hostname)
            ?.toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "git-vault";
    return { name, email: `${localPart}@git-vault.local` };
}

export function buildForgejoRemoteUrl(
    baseUrl: string,
    owner: string,
    repository: string
): string {
    const url = new URL(baseUrl.trim());
    const segments = [...owner.split("/"), repository]
        .map((segment) => decodeURIComponent(segment.trim()))
        .filter(Boolean)
        .map(encodeURIComponent);
    if (segments.length < 2) {
        throw new Error("Forgejo owner and repository must be configured.");
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${segments.join("/")}.git`;
    url.search = "";
    url.hash = "";
    return url.toString();
}

class NativeForgejoGitTransport implements ForgejoGitTransport {
    readonly kind = "native" as const;
    private readonly manager: SimpleGit;
    private readonly root: string;
    private gitBinary: string;

    constructor(private readonly plugin: ObsidianGit) {
        this.manager = plugin.gitManager as SimpleGit;
        const adapter = plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            throw new Error("Native Forgejo sync requires a filesystem vault.");
        }
        this.root = path.resolve(
            adapter.getBasePath(),
            plugin.settings.basePath || ""
        );
        this.gitBinary = plugin.localStorage.getGitPath() || "git";
    }

    private async run(
        args: string[],
        options: { allowFailure?: boolean; binary?: boolean } = {}
    ): Promise<string | Uint8Array> {
        const execute = (command: string) =>
            new Promise<{
                code: number;
                stdout: Buffer;
                stderr: string;
                error?: Error;
            }>((resolve) => {
                const child = spawn(command, args, {
                    cwd: this.root,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
                    windowsHide: true,
                });
                const stdout: Buffer[] = [];
                let stderr = "";
                child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
                child.stderr.on("data", (chunk: Buffer) => {
                    stderr += chunk.toString("utf8");
                });
                child.once("error", (error) =>
                    resolve({
                        code: 1,
                        stdout: Buffer.concat(stdout),
                        stderr,
                        error,
                    })
                );
                child.once("close", (code) =>
                    resolve({
                        code: code ?? 1,
                        stdout: Buffer.concat(stdout),
                        stderr,
                    })
                );
            });

        let result = await execute(this.gitBinary);
        if (
            result.error &&
            Platform.isWin &&
            !this.plugin.localStorage.getGitPath()
        ) {
            result = await execute(DEFAULT_WIN_GIT_PATH);
            if (!result.error) this.gitBinary = DEFAULT_WIN_GIT_PATH;
        }
        if ((result.error || result.code !== 0) && !options.allowFailure) {
            throw new Error(
                `Git ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`
            );
        }
        return options.binary
            ? new Uint8Array(result.stdout)
            : result.stdout.toString("utf8").trim();
    }

    private async resolve(ref: string): Promise<string | null> {
        const value = (await this.run(["rev-parse", "--verify", ref], {
            allowFailure: true,
        })) as string;
        return /^[0-9a-f]{40,64}$/i.test(value) ? value : null;
    }

    async init(remoteUrl: string, branch: string): Promise<void> {
        await this.run(["--version"]);
        const inside = (await this.run(["rev-parse", "--is-inside-work-tree"], {
            allowFailure: true,
        })) as string;
        if (inside !== "true") await this.run(["init", "-b", branch]);
        const remotes = ((await this.run(["remote"])) as string)
            .split(/\r?\n/)
            .filter(Boolean);
        await this.run(
            remotes.includes("origin")
                ? ["remote", "set-url", "origin", remoteUrl]
                : ["remote", "add", "origin", remoteUrl]
        );
    }

    async fetch(branch: string): Promise<string | null> {
        try {
            await this.run([
                "fetch",
                "--no-tags",
                "--prune",
                "origin",
                `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
            ]);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (
                !/couldn['’]t find remote ref|remote ref .* not found/i.test(
                    message
                )
            ) {
                throw error;
            }
            return null;
        }
        return this.resolve(`refs/remotes/origin/${branch}`);
    }

    readBaseOid(): Promise<string | null> {
        return this.resolve(FORGEJO_BASE_REF);
    }

    async readSnapshot(ref: string | null): Promise<ForgejoSnapshot> {
        const snapshot: ForgejoSnapshot = new Map();
        if (!ref) return snapshot;
        const output = (await this.run(
            ["ls-tree", "-r", "-z", "--name-only", ref],
            {
                binary: true,
            }
        )) as Uint8Array;
        const names = Buffer.from(output)
            .toString("utf8")
            .split("\0")
            .filter((name) => name && isForgejoSyncPath(name));
        for (const name of names) {
            const content = (await this.run(["show", `${ref}:${name}`], {
                binary: true,
            })) as Uint8Array;
            snapshot.set(normalizeGitPath(name), content);
        }
        return snapshot;
    }

    async listBranches(): Promise<string[]> {
        const output = (await this.run([
            "for-each-ref",
            "--format=%(refname:strip=3)",
            "refs/remotes/origin",
        ])) as string;
        return output.split(/\r?\n/).filter((name) => name && name !== "HEAD");
    }

    async begin(
        remoteOid: string | null,
        branch: string
    ): Promise<ForgejoGitTransaction> {
        const originalHead = await this.resolve("HEAD");
        const originalBase = await this.resolve(FORGEJO_BASE_REF);
        const writtenIndex = (await this.run(["write-tree"], {
            allowFailure: true,
        })) as string;
        const originalIndex = /^[0-9a-f]{40,64}$/i.test(writtenIndex)
            ? writtenIndex
            : null;
        await this.run(["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
        if (remoteOid) await this.run(["reset", "--mixed", remoteOid]);
        return { originalHead, originalBase, originalIndex };
    }

    async stage(paths: string[]): Promise<void> {
        const unique = [...new Set(paths.map(normalizeGitPath))].filter(
            isForgejoSyncPath
        );
        for (let offset = 0; offset < unique.length; offset += 100) {
            await this.run([
                "add",
                "-A",
                "--",
                ...unique.slice(offset, offset + 100),
            ]);
        }
    }

    async commit(message: string): Promise<string> {
        await this.run(["commit", "--no-gpg-sign", "-m", message]);
        const oid = await this.resolve("HEAD");
        if (!oid) throw new Error("Git created no commit.");
        return oid;
    }

    async push(branch: string): Promise<void> {
        await this.run(["push", "origin", `HEAD:refs/heads/${branch}`]);
    }

    async updateBase(oid: string): Promise<void> {
        await this.run(["update-ref", FORGEJO_BASE_REF, oid]);
    }

    async rollback(
        transaction: ForgejoGitTransaction,
        branch: string
    ): Promise<void> {
        if (transaction.originalHead) {
            await this.run(["reset", "--mixed", transaction.originalHead]);
        } else {
            await this.run(["update-ref", "-d", `refs/heads/${branch}`], {
                allowFailure: true,
            });
        }
        if (transaction.originalBase) {
            await this.run([
                "update-ref",
                FORGEJO_BASE_REF,
                transaction.originalBase,
            ]);
        } else {
            await this.run(["update-ref", "-d", FORGEJO_BASE_REF], {
                allowFailure: true,
            });
        }
        if (transaction.originalIndex) {
            await this.run(["read-tree", transaction.originalIndex]);
        }
    }
}

class IsomorphicForgejoGitTransport implements ForgejoGitTransport {
    readonly kind = "isomorphic" as const;
    private readonly manager: IsomorphicGit;
    private readonly mobileDir: string;
    private remoteUrl = "";

    constructor(private readonly plugin: ObsidianGit) {
        this.manager = plugin.gitManager as IsomorphicGit;
        const target =
            `${plugin.settings.giteaOwner}-${plugin.settings.giteaRepo}`
                .replace(/[^a-z0-9._-]+/gi, "-")
                .replace(/^-+|-+$/g, "") || "forgejo";
        this.mobileDir = normalizePath(
            `${plugin.app.vault.configDir}/.git-vault-mobile/${target}`
        );
    }

    private repo() {
        return {
            ...this.manager.getRepo(),
            dir: this.mobileDir,
            gitdir: undefined,
        };
    }

    private async ensureDirectory(directory: string): Promise<void> {
        const parts = normalizePath(directory).split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!(await this.plugin.app.vault.adapter.exists(current))) {
                await this.plugin.app.vault.adapter.mkdir(current);
            }
        }
    }

    private async resolve(ref: string): Promise<string | null> {
        try {
            return await git.resolveRef({ ...this.repo(), ref });
        } catch {
            return null;
        }
    }

    async init(remoteUrl: string, branch: string): Promise<void> {
        this.remoteUrl = remoteUrl;
        await this.ensureDirectory(this.mobileDir);
        if (
            !(await this.plugin.app.vault.adapter.exists(
                `${this.mobileDir}/.git/HEAD`
            ))
        ) {
            await git.init({ ...this.repo(), defaultBranch: branch });
        }
        const remotes = await git.listRemotes(this.repo());
        const origin = remotes.find((remote) => remote.remote === "origin");
        if (origin) {
            await git.setConfig({
                ...this.repo(),
                path: "remote.origin.url",
                value: remoteUrl,
            });
        } else {
            await git.addRemote({
                ...this.repo(),
                remote: "origin",
                url: remoteUrl,
            });
        }
    }

    async fetch(branch: string): Promise<string | null> {
        try {
            await git.fetch({
                ...this.repo(),
                remote: "origin",
                ref: branch,
                singleBranch: true,
                tags: false,
                prune: true,
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            if (
                !/couldn['’]t find remote ref|no such ref|notfounderror/i.test(
                    message
                )
            ) {
                throw error;
            }
            return null;
        }
        return this.resolve(`refs/remotes/origin/${branch}`);
    }

    async repairCorruptedCache(branch: string): Promise<void> {
        if (!this.remoteUrl) {
            throw new Error(
                "Cannot rebuild the mobile Forgejo cache before transport initialization."
            );
        }

        this.manager.clearFsCache();
        const adapter = this.plugin.app.vault.adapter;
        if (await adapter.exists(this.mobileDir)) {
            await adapter.rmdir(this.mobileDir, true);
        }
        await this.init(this.remoteUrl, branch);
    }

    readBaseOid(): Promise<string | null> {
        return this.resolve(FORGEJO_BASE_REF);
    }

    async readSnapshot(ref: string | null): Promise<ForgejoSnapshot> {
        const snapshot: ForgejoSnapshot = new Map();
        if (!ref) return snapshot;
        await git.walk({
            ...this.repo(),
            trees: [git.TREE({ ref })],
            map: async (filepath, [entry]) => {
                if (
                    !entry ||
                    (await entry.type()) !== "blob" ||
                    !isForgejoSyncPath(filepath)
                ) {
                    return;
                }
                const oid = await entry.oid();
                const { blob } = await git.readBlob({ ...this.repo(), oid });
                snapshot.set(normalizeGitPath(filepath), blob);
            },
        });
        return snapshot;
    }

    async listBranches(): Promise<string[]> {
        return git.listBranches({ ...this.repo(), remote: "origin" });
    }

    async begin(
        remoteOid: string | null,
        branch: string
    ): Promise<ForgejoGitTransaction> {
        const originalHead = await this.resolve("HEAD");
        const originalBase = await this.resolve(FORGEJO_BASE_REF);
        await git.setConfig({
            ...this.repo(),
            path: "init.defaultBranch",
            value: branch,
        });
        if (remoteOid) {
            await git.writeRef({
                ...this.repo(),
                ref: `refs/heads/${branch}`,
                value: remoteOid,
                force: true,
            });
            // The checkout is isolated inside .obsidian/.git-vault-mobile.
            // It populates a complete index without ever touching user files.
            await git.checkout({ ...this.repo(), ref: branch, force: true });
        }
        return { originalHead, originalBase };
    }

    async stage(paths: string[]): Promise<void> {
        for (const filepath of [...new Set(paths)].filter(isForgejoSyncPath)) {
            const vaultPath = this.manager.getRelativeVaultPath(filepath);
            if (await this.plugin.app.vault.adapter.exists(vaultPath)) {
                const worktreePath = normalizePath(
                    `${this.mobileDir}/${filepath}`
                );
                await this.ensureDirectory(
                    worktreePath.split("/").slice(0, -1).join("/")
                );
                const content =
                    await this.plugin.app.vault.adapter.readBinary(vaultPath);
                await this.plugin.app.vault.adapter.writeBinary(
                    worktreePath,
                    content
                );
                await git.add({ ...this.repo(), filepath });
            } else {
                const worktreePath = normalizePath(
                    `${this.mobileDir}/${filepath}`
                );
                if (await this.plugin.app.vault.adapter.exists(worktreePath)) {
                    await this.plugin.app.vault.adapter.remove(worktreePath);
                }
                await git
                    .remove({ ...this.repo(), filepath })
                    .catch(() => undefined);
            }
        }
    }

    private async getCommitAuthor(): Promise<{
        name: string;
        email: string;
    }> {
        const readRepositoryConfig = async (
            path: "user.name" | "user.email"
        ): Promise<string | undefined> => {
            const value: unknown = await git
                .getConfig({ ...this.repo(), path })
                .catch(() => undefined);
            return typeof value === "string" ? value : undefined;
        };
        const readConfiguredAuthor = async (
            path: "user.name" | "user.email"
        ): Promise<string | undefined> => {
            const value: unknown = await this.manager
                .getConfig(path)
                .catch(() => undefined);
            return typeof value === "string" ? value : undefined;
        };
        const [
            repositoryName,
            repositoryEmail,
            configuredName,
            configuredEmail,
        ] = await Promise.all([
            readRepositoryConfig("user.name"),
            readRepositoryConfig("user.email"),
            readConfiguredAuthor("user.name"),
            readConfiguredAuthor("user.email"),
        ]);

        return buildForgejoCommitAuthor({
            repositoryName,
            repositoryEmail,
            configuredName,
            configuredEmail,
            owner: this.plugin.settings.giteaOwner,
            hostname: this.plugin.localStorage.getHostname(),
        });
    }

    async commit(message: string): Promise<string> {
        const author = await this.getCommitAuthor();
        const oid = await git.commit({ ...this.repo(), message, author });
        return oid;
    }

    async push(branch: string): Promise<void> {
        await git.push({ ...this.repo(), remote: "origin", ref: branch });
    }

    async updateBase(oid: string): Promise<void> {
        await git.writeRef({
            ...this.repo(),
            ref: FORGEJO_BASE_REF,
            value: oid,
            force: true,
        });
    }

    async rollback(
        transaction: ForgejoGitTransaction,
        branch: string
    ): Promise<void> {
        if (transaction.originalHead) {
            await git.writeRef({
                ...this.repo(),
                ref: `refs/heads/${branch}`,
                value: transaction.originalHead,
                force: true,
            });
        } else {
            await git
                .deleteRef({ ...this.repo(), ref: `refs/heads/${branch}` })
                .catch(() => undefined);
        }
        if (transaction.originalBase) {
            await git.writeRef({
                ...this.repo(),
                ref: FORGEJO_BASE_REF,
                value: transaction.originalBase,
                force: true,
            });
        } else {
            await git
                .deleteRef({ ...this.repo(), ref: FORGEJO_BASE_REF })
                .catch(() => undefined);
        }
    }
}

export function createForgejoGitTransport(
    plugin: ObsidianGit
): ForgejoGitTransport {
    return Platform.isDesktopApp
        ? new NativeForgejoGitTransport(plugin)
        : new IsomorphicForgejoGitTransport(plugin);
}
