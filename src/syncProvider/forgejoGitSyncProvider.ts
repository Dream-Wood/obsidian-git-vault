import { moment, normalizePath } from "obsidian";
import type ObsidianGit from "../main";
import {
    compileExcludePatterns,
    isPathExcludedByCompiledPatterns,
} from "./excludeMatcher";
import {
    type ForgejoSnapshot,
    mergeForgejoSnapshots,
    snapshotsEqual,
} from "./forgejoThreeWayMerge";
import {
    buildForgejoRemoteUrl,
    createForgejoGitTransport,
    type ForgejoGitTransaction,
    type ForgejoGitTransport,
    isForgejoSyncPath,
    isPackfileCorruptionError,
} from "./forgejoGitTransport";
import { isPathInTrackedDirectory, toRemoteScopedPath } from "./pathScope";
import { getSyncProviderCapabilities } from "./providerRegistry";
import type {
    Conflict,
    ConflictResolution,
    SyncBranchSelection,
    SyncFileMetadata,
    SyncProvider,
    SyncResult,
    SyncStatus,
} from "./syncProvider";

interface PendingForgejoMerge {
    branch: string;
    localBefore: ForgejoSnapshot;
    remote: ForgejoSnapshot;
    remoteOid: string | null;
    merged: ForgejoSnapshot;
    conflictsByVaultPath: Map<string, { gitPath: string; conflict: Conflict }>;
}

function cloneSnapshot(snapshot: ForgejoSnapshot): ForgejoSnapshot {
    return new Map(
        [...snapshot].map(([path, content]) => [path, content.slice()])
    );
}

function byteChanges(left: ForgejoSnapshot, right: ForgejoSnapshot): number {
    const paths = new Set([...left.keys(), ...right.keys()]);
    let count = 0;
    for (const path of paths) {
        const a = left.get(path);
        const b = right.get(path);
        if (!a || !b || a.byteLength !== b.byteLength) {
            count++;
            continue;
        }
        if (a.some((value, index) => value !== b[index])) count++;
    }
    return count;
}

export class ForgejoGitSyncProvider implements SyncProvider {
    private readonly transport: ForgejoGitTransport;
    private pending: PendingForgejoMerge | null = null;
    private initialized = false;

    constructor(
        private readonly plugin: ObsidianGit,
        transport?: ForgejoGitTransport
    ) {
        this.transport = transport ?? createForgejoGitTransport(plugin);
    }

    private get branch(): string {
        return this.plugin.settings.giteaBranch?.trim() || "main";
    }

    private get excludedPatterns(): RegExp[] {
        return compileExcludePatterns(
            this.plugin.settings.syncExcludePaths ?? []
        );
    }

    private vaultToGitPath(vaultPath: string): string {
        return normalizePath(
            this.plugin.gitManager.getRelativeRepoPath(vaultPath, true)
        );
    }

    private gitToVaultPath(gitPath: string): string {
        return normalizePath(
            this.plugin.gitManager.getRelativeVaultPath(gitPath)
        );
    }

    private isInScope(vaultPath: string): boolean {
        if (!isForgejoSyncPath(vaultPath)) return false;
        if (
            !isPathInTrackedDirectory(
                vaultPath,
                this.plugin.settings.trackedDirectory ?? ""
            )
        ) {
            return false;
        }
        const scopedPath = toRemoteScopedPath(
            vaultPath,
            this.plugin.settings.trackedDirectory ?? ""
        );
        return !isPathExcludedByCompiledPatterns(
            scopedPath,
            this.excludedPatterns
        );
    }

    private async readLocalSnapshot(): Promise<ForgejoSnapshot> {
        const snapshot: ForgejoSnapshot = new Map();
        for (const file of this.plugin.app.vault.getFiles()) {
            if (!this.isInScope(file.path)) continue;
            const gitPath = this.vaultToGitPath(file.path);
            if (
                !gitPath ||
                gitPath.startsWith("../") ||
                !isForgejoSyncPath(gitPath)
            ) {
                continue;
            }
            snapshot.set(
                gitPath,
                new Uint8Array(await this.plugin.app.vault.readBinary(file))
            );
        }
        return snapshot;
    }

    private filterRemoteSnapshot(snapshot: ForgejoSnapshot): ForgejoSnapshot {
        return new Map(
            [...snapshot].filter(([gitPath]) =>
                this.isInScope(this.gitToVaultPath(gitPath))
            )
        );
    }

    private async ensureParentDirectories(vaultPath: string): Promise<void> {
        const parts = normalizePath(vaultPath).split("/").slice(0, -1);
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!(await this.plugin.app.vault.adapter.exists(current))) {
                await this.plugin.app.vault.adapter.mkdir(current);
            }
        }
    }

    private async applySnapshot(
        target: ForgejoSnapshot,
        current: ForgejoSnapshot
    ): Promise<void> {
        const paths = new Set([...current.keys(), ...target.keys()]);
        for (const gitPath of [...paths].sort()) {
            if (!isForgejoSyncPath(gitPath)) continue;
            const vaultPath = this.gitToVaultPath(gitPath);
            if (!this.isInScope(vaultPath)) continue;
            const content = target.get(gitPath);
            if (content) {
                await this.ensureParentDirectories(vaultPath);
                const bytes = content.slice();
                await this.plugin.app.vault.adapter.writeBinary(
                    vaultPath,
                    bytes.buffer
                );
            } else if (await this.plugin.app.vault.adapter.exists(vaultPath)) {
                await this.plugin.app.vault.adapter.remove(vaultPath);
            }
        }
    }

    private async withMobilePackfileRepair<T>(
        branch: string,
        action: () => Promise<T>
    ): Promise<T> {
        try {
            return await action();
        } catch (error) {
            if (
                !isPackfileCorruptionError(error) ||
                !this.transport.repairCorruptedCache
            ) {
                throw error;
            }

            console.warn(
                "[Git Vault] Corrupted mobile Forgejo packfile detected; rebuilding the isolated cache and retrying once.",
                error
            );
            this.plugin.showNotice(
                "Git Vault detected a damaged mobile Git cache. Rebuilding it and retrying sync once.",
                8000
            );
            await this.transport.repairCorruptedCache(branch);
            return action();
        }
    }

    private async publish(
        merged: ForgejoSnapshot,
        localBefore: ForgejoSnapshot,
        remote: ForgejoSnapshot,
        remoteOid: string | null,
        branch: string
    ): Promise<number> {
        let transaction: ForgejoGitTransaction | null = null;
        try {
            transaction = await this.transport.begin(remoteOid, branch);
            await this.plugin.runWithSuppressedVaultChangeEffects(async () => {
                await this.applySnapshot(merged, localBefore);
            });
            const stagedPaths = [
                ...new Set([
                    ...localBefore.keys(),
                    ...remote.keys(),
                    ...merged.keys(),
                ]),
            ];
            await this.transport.stage(stagedPaths);

            let finalOid = remoteOid;
            if (!snapshotsEqual(merged, remote)) {
                const changedPaths = stagedPaths.filter((gitPath) => {
                    const before = remote.get(gitPath);
                    const after = merged.get(gitPath);
                    if (
                        !before ||
                        !after ||
                        before.byteLength !== after.byteLength
                    ) {
                        return before !== after;
                    }
                    return before.some(
                        (value, index) => value !== after[index]
                    );
                });
                let message =
                    this.plugin.settings.commitMessage || "vault sync";
                message = message
                    .replace(
                        "{{date}}",
                        moment
                            .utc()
                            .local()
                            .format(this.plugin.settings.commitDateFormat)
                    )
                    .replace("{{numFiles}}", String(changedPaths.length))
                    .replace(
                        "{{hostname}}",
                        this.plugin.localStorage.getHostname() || ""
                    )
                    .replace(
                        "{{files}}",
                        changedPaths.length < 100
                            ? changedPaths.join(", ")
                            : "Too many files to list"
                    );
                if (this.plugin.settings.listChangedFilesInMessageBody) {
                    message += `\n\nAffected files:\n${
                        changedPaths.length < 100
                            ? changedPaths.join("\n")
                            : "Too many files to list"
                    }`;
                }
                finalOid = await this.transport.commit(message);
                // The base ref is local transaction state. Move it before the
                // network write so a rejected push can restore every local ref.
                await this.transport.updateBase(finalOid);
                await this.transport.push(branch);
            } else if (finalOid) {
                await this.transport.updateBase(finalOid);
            }

            this.pending = null;
            return byteChanges(localBefore, merged);
        } catch (error) {
            await this.plugin.runWithSuppressedVaultChangeEffects(async () => {
                await this.applySnapshot(localBefore, merged).catch(
                    () => undefined
                );
            });
            if (transaction) {
                await this.transport
                    .rollback(transaction, branch)
                    .catch(() => undefined);
            }
            throw error;
        }
    }

    async init(): Promise<void> {
        const remoteUrl = buildForgejoRemoteUrl(
            this.plugin.settings.giteaBaseUrl,
            this.plugin.settings.giteaOwner,
            this.plugin.settings.giteaRepo
        );
        await this.transport.init(remoteUrl, this.branch);
        this.initialized = true;
    }

    async sync(): Promise<SyncResult> {
        if (!this.initialized) await this.init();
        const branch = this.branch;
        const localBefore = await this.readLocalSnapshot();

        // This is intentionally the only network read in a sync transaction.
        const { remoteOid, unfilteredBase, unfilteredRemote } =
            await this.withMobilePackfileRepair(branch, async () => {
                const remoteOid = await this.transport.fetch(branch);
                const baseOid = await this.transport.readBaseOid();
                const [unfilteredBase, unfilteredRemote] = await Promise.all([
                    baseOid
                        ? this.transport.readSnapshot(baseOid)
                        : Promise.resolve(null),
                    this.transport.readSnapshot(remoteOid),
                ]);
                return { remoteOid, unfilteredBase, unfilteredRemote };
            });
        const base = unfilteredBase
            ? this.filterRemoteSnapshot(unfilteredBase)
            : null;
        const remote = this.filterRemoteSnapshot(unfilteredRemote);
        const result = mergeForgejoSnapshots(base, localBefore, remote);

        if (result.conflicts.length > 0) {
            const conflictsByVaultPath = new Map<
                string,
                { gitPath: string; conflict: Conflict }
            >();
            const conflicts = result.conflicts.map((conflict) => {
                const vaultPath = this.gitToVaultPath(conflict.path);
                const uiConflict = { ...conflict, path: vaultPath };
                conflictsByVaultPath.set(vaultPath, {
                    gitPath: conflict.path,
                    conflict: uiConflict,
                });
                return uiConflict;
            });
            this.pending = {
                branch,
                localBefore,
                remote,
                remoteOid,
                merged: result.merged,
                conflictsByVaultPath,
            };
            return {
                filesChanged: 0,
                conflicts,
                message: `Forgejo sync found ${conflicts.length} three-way conflict(s). Nothing was written.`,
                success: false,
            };
        }

        const filesChanged = await this.publish(
            result.merged,
            localBefore,
            remote,
            remoteOid,
            branch
        );
        return {
            filesChanged,
            conflicts: [],
            message:
                filesChanged === 0
                    ? "Forgejo is already synchronized."
                    : `Forgejo synchronized ${filesChanged} file(s).`,
            success: true,
        };
    }

    async pull(): Promise<void> {
        const result = await this.sync();
        if (!result.success) throw new Error(result.message);
    }

    async push(): Promise<void> {
        const result = await this.sync();
        if (!result.success) throw new Error(result.message);
    }

    async resolveConflicts(resolutions: ConflictResolution[]): Promise<void> {
        const pending = this.pending;
        if (!pending)
            throw new Error("There is no active Forgejo conflict transaction.");
        const merged = cloneSnapshot(pending.merged);
        for (const resolution of resolutions) {
            const entry = pending.conflictsByVaultPath.get(resolution.path);
            if (!entry)
                throw new Error(`Unknown Forgejo conflict: ${resolution.path}`);
            const conflict = entry.conflict;
            let content: string | Uint8Array | undefined;
            switch (resolution.strategy) {
                case "always-remote":
                    content = conflict.remoteContent;
                    break;
                case "manual":
                    content = resolution.manualContent;
                    break;
                case "always-local":
                case "last-write-wins":
                    content = conflict.localContent;
                    break;
            }
            if (content === undefined) {
                merged.delete(entry.gitPath);
            } else {
                merged.set(
                    entry.gitPath,
                    typeof content === "string"
                        ? new TextEncoder().encode(content)
                        : content
                );
            }
        }
        if (resolutions.length !== pending.conflictsByVaultPath.size) {
            throw new Error(
                "Every Forgejo conflict must be resolved atomically."
            );
        }
        await this.publish(
            merged,
            pending.localBefore,
            pending.remote,
            pending.remoteOid,
            pending.branch
        );
    }

    getStatus(): Promise<SyncStatus> {
        const state = this.plugin.syncState.getState();
        return Promise.resolve({
            hasChanges: state.pendingChanges.length > 0,
            hasConflicts: this.pending !== null || state.conflicts.length > 0,
            lastSyncTime: state.lastSyncTime,
            pendingFiles: state.pendingChanges.length,
            provider: "gitea",
            online: !this.plugin.state.offlineMode,
        });
    }

    getCapabilities() {
        return getSyncProviderCapabilities("gitea");
    }

    getFileMetadata(path: string): Promise<SyncFileMetadata> {
        const inScope = this.isInScope(path);
        return Promise.resolve({
            path,
            inScope,
            excluded: !inScope,
            provider: "gitea",
            remotePath: inScope ? this.vaultToGitPath(path) : undefined,
            lastSyncTime: this.plugin.syncState.getState().lastSyncTime,
            lastSyncResult: this.pending?.conflictsByVaultPath.has(path)
                ? "conflict"
                : "ok",
        });
    }

    async getBranchSelection(): Promise<SyncBranchSelection> {
        const branches = await this.transport.listBranches().catch(() => []);
        return {
            branches: [...new Set([this.branch, ...branches])].sort(),
            current: this.branch,
        };
    }

    async switchBranch(branch: string): Promise<void> {
        this.plugin.settings.giteaBranch = branch;
        await this.plugin.saveSettings();
        this.pending = null;
    }

    async checkoutBranchSnapshot(): Promise<number> {
        if (!this.initialized) await this.init();
        const localBefore = await this.readLocalSnapshot();
        const { remoteOid, remote } = await this.withMobilePackfileRepair(
            this.branch,
            async () => {
                const remoteOid = await this.transport.fetch(this.branch);
                const remote = this.filterRemoteSnapshot(
                    await this.transport.readSnapshot(remoteOid)
                );
                return { remoteOid, remote };
            }
        );
        return this.publish(
            remote,
            localBefore,
            remote,
            remoteOid,
            this.branch
        );
    }
}
