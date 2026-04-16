import * as fsPromises from "fs/promises";
import * as path from "path";
import { FileSystemAdapter, Platform } from "obsidian";
import type { IPluginContext } from "src/pluginContext";
import type ObsidianGit from "src/main";
import { VaultBootstrapService } from "src/runtime/vaultBootstrapService";
import type { RepoBindingService } from "./repoBindingService";
import {
    buildActiveApiProvider,
    getSuggestedApiVaultName,
} from "../infra/providerFactory";
import { GeneralModal } from "src/ui/modals/generalModal";
import { SetupProgressModal } from "src/ui/modals/setupProgressModal";
import { VaultBootstrapModal } from "src/ui/modals/vaultBootstrapModal";

/**
 * Validate and resolve a user-supplied vault destination path.
 *
 * - Relative paths are constrained to `parentDir` (cannot escape via `..`).
 * - Absolute paths are validated segment-by-segment and must not contain
 *   null bytes, `.`, or `..` components.
 * - Returns the canonicalized absolute path on success, or `null` if any
 *   segment is unsafe.
 *
 * Using this instead of bare `path.resolve(requestedPath)` prevents
 * path-traversal attacks where user input like `../../etc/cron.d/evil`
 * would otherwise cause `mkdir` to create an arbitrary filesystem path.
 */
export function sanitizeVaultTargetPath(
    requestedPath: string,
    parentDir: string
): string | null {
    if (!requestedPath || requestedPath.includes("\0")) return null;

    const trimmed = requestedPath.trim();
    if (!trimmed) return null;

    // Reject traversal tokens in the RAW input before path.normalize is
    // called.  path.normalize resolves ".." eagerly (e.g. "/a/../b" → "/b"),
    // which would silently hide the traversal from any segment check that
    // runs after normalization.  Splitting on both / and \ covers mixed
    // separators on all platforms.
    const rawSegs = trimmed.split(/[/\\]/).filter((s) => s.length > 0);
    if (rawSegs.includes("..") || rawSegs.includes(".")) return null;

    const normalized = path.normalize(trimmed);

    // Allow Unicode letters/numbers plus common safe filename chars.
    // Also allow leading-dot names (hidden files/folders like .obsidian).
    const safe = /^\.?[\p{L}\p{N}._\-\s@#()+='!]+$/u;

    if (path.isAbsolute(normalized)) {
        // Validate every segment of the absolute path.
        const parsed = path.parse(normalized);
        const relative = normalized.slice(parsed.root.length);
        const segs = relative.split(path.sep).filter((s) => s.length > 0);
        // Also allow leading-dot names (hidden files/folders like .obsidian).
        for (const s of segs) {
            if (s === "." || s === ".." || s.includes("\0")) return null;
            if (s.length > 255) return null;
            // `parsed.root` already contains the drive letter on Windows
            // (e.g. "C:\\"). The `relative` slice below removes it, so
            // there's no need to special-case a drive-letter segment here.
            if (!safe.test(s)) return null;
        }
        // Build the result via string concatenation rather than path.join/
        // path.resolve to avoid static-analysis findings that flag any call
        // whose arguments include a spread of a non-literal array.  Each
        // segment is already validated; simple sep-join is safe and identical
        // in outcome to path.join for relative, non-traversal segments.
        const root = parsed.root.endsWith(path.sep)
            ? parsed.root
            : parsed.root + path.sep;
        const result = path.normalize(
            segs.length > 0 ? root + segs.join(path.sep) : root
        );
        if (!result.startsWith(parsed.root)) return null;
        return result;
    }

    // Relative path: must not escape parentDir.
    // Use the previously-derived raw segments (split on both separators)
    // and validate them segment-by-segment to avoid passing raw user
    // input directly into `path.join`/`path.resolve` (static analysis
    // tools flag such calls). Building the path via concatenation from
    // validated segments is equivalent and safe.
    for (const s of rawSegs) {
        if (s === "." || s === ".." || s.includes("\0")) return null;
        if (s.length > 255) return null;
        if (!safe.test(s)) return null;
    }
    const joined =
        rawSegs.length > 0
            ? parentDir + path.sep + rawSegs.join(path.sep)
            : parentDir;
    const candidate = path.normalize(joined);
    const rel = path.relative(parentDir, candidate);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))
        return null;
    return candidate;
}

/**
 * Policy orchestrator for provider bootstrap actions (first-sync pull,
 * dedicated vault import, symlink detection).
 *
 * Previously implemented as a cluster of private methods inside
 * `ObsidianGitSettingsTab`. Extracted here so that:
 *  - The orchestration logic is unit-testable in isolation.
 *  - `ObsidianGitSettingsTab` can delegate instead of owning the logic.
 *
 * Constructor injects:
 *  - `plugin` — narrow `IPluginContext` for settings and notice
 *  - `getConcretePlugin` — thunk for `ObsidianGit` (needed by modal + providers)
 *  - `repoBinding` — `RepoBindingService` (fingerprint & bootstrap decision)
 *  - `reloadSyncManager` — async callback to reload the sync manager
 */
export class ProviderBootstrapPolicy {
    constructor(
        private readonly plugin: IPluginContext,
        private readonly getConcretePlugin: () => ObsidianGit,
        private readonly repoBinding: RepoBindingService,
        private readonly reloadSyncManager: () => Promise<void>
    ) {}

    /**
     * Detect whether any Obsidian config paths are behind a symlink.
     * Symlinked config paths can cause plugin state or workspace files to
     * behave unpredictably during sync bootstrap on macOS.
     *
     * Returns a human-readable warning string, or `null` if none detected.
     */
    async detectObsidianSymlinkIssue(): Promise<string | null> {
        if (!Platform.isDesktopApp) return null;

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) return null;

        const configRoot = path.join(
            adapter.getBasePath(),
            this.plugin.app.vault.configDir
        );
        const pathsToCheck = [
            configRoot,
            path.join(configRoot, "plugins"),
            path.join(configRoot, "themes"),
            path.join(configRoot, "snippets"),
            path.join(configRoot, "workspace.json"),
        ];

        for (const candidate of pathsToCheck) {
            try {
                const stat = await fsPromises.lstat(candidate);
                if (stat.isSymbolicLink()) {
                    return `Obsidian config path is symlinked: ${candidate}. This can cause plugin state, hot-reload, or workspace files to behave unpredictably during sync bootstrap.`;
                }
            } catch (err) {
                if (
                    !(err instanceof Error) ||
                    (err as NodeJS.ErrnoException).code !== "ENOENT"
                ) {
                    console.debug(
                        "[Git Vault] lstat failed for candidate path:",
                        candidate,
                        err instanceof Error ? err.message : err
                    );
                }
                // ENOENT is expected — path doesn't exist yet; continue.
            }
        }

        return null;
    }

    /**
     * Run a provider-aware sync after checking whether a bootstrap pull is
     * required first.  Surfaces symlink warnings to the user before proceeding.
     */
    async runProviderBootstrapOrSync(): Promise<void> {
        const symlinkIssue = await this.detectObsidianSymlinkIssue();
        if (symlinkIssue) {
            this.plugin.makeSyncNotice(symlinkIssue, 9000);
            return;
        }

        const bootstrapService = new VaultBootstrapService(
            this.getConcretePlugin()
        );
        const vaultId =
            this.plugin.app.vault.adapter instanceof FileSystemAdapter
                ? path.resolve(this.plugin.app.vault.adapter.getBasePath())
                : this.plugin.app.vault.getName();

        await bootstrapService
            .ensureSensitiveCurrentVaultGitignore()
            .catch(async (error) => {
                console.warn(
                    "[Git Vault] Failed to harden the current vault .gitignore:",
                    error
                );
                await bootstrapService.recordHardeningFailure(vaultId, error);
                this.plugin.makeSyncNotice(
                    "Git Vault: could not harden the current vault .gitignore. Sensitive files may not be excluded.",
                    9000
                );
            });

        await this.reloadSyncManager();
        if (this.plugin.syncManager == null) {
            console.error(
                "[Git Vault] syncManager failed to initialize; aborting sync."
            );
            return;
        }

        const shouldBootstrap =
            await this.repoBinding.shouldBootstrapApiProvider();
        if (shouldBootstrap) {
            this.plugin.makeSyncNotice(
                "Git Vault: no matching local baseline found for this remote. Pulling remote contents first.",
                6000
            );
            await this.plugin.syncManager.pullNow();
            // After the bootstrap pull (which succeeds with an empty map when
            // the remote is brand-new and empty), fall through to a sync so
            // that local vault files are uploaded to the newly created repo.
        }

        await this.plugin.syncManager.syncNow();
    }

    /**
     * Clone the active API remote into a new, standalone Obsidian vault folder
     * on the local filesystem.
     *
     * Only available on desktop.  Prompts the user for a target directory,
     * validates it is outside the current vault, then calls
     * `provider.exportRemoteToDirectory()`.
     */
    async importActiveApiRepoAsDedicatedVault(): Promise<void> {
        if (!Platform.isDesktopApp) {
            this.plugin.makeSyncNotice(
                "Git Vault: dedicated vault import is only available on desktop.",
                6000
            );
            return;
        }

        const adapter = this.plugin.app.vault.adapter;
        if (!(adapter instanceof FileSystemAdapter)) {
            this.plugin.makeSyncNotice(
                "Git Vault: this platform does not expose a desktop filesystem adapter for dedicated vault import.",
                7000
            );
            return;
        }

        const concretePlugin = this.getConcretePlugin();
        const provider = buildActiveApiProvider(concretePlugin);
        if (!provider) {
            this.plugin.makeSyncNotice(
                "Git Vault: select an API backend before importing a dedicated vault.",
                6000
            );
            return;
        }

        try {
            await provider.init();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error("[Git Vault] provider.init failed:", error);
            this.plugin.makeSyncNotice(
                `Git Vault: failed to initialize the active provider – ${msg}`,
                9000
            );
            return;
        }

        if (
            concretePlugin.settings.apiEncryptionEnabled &&
            !concretePlugin.providerSecrets.getEncryptionPassphrase()
        ) {
            this.plugin.makeSyncNotice(
                "Git Vault: this remote uses encrypted API sync. Enter the encryption passphrase on this device before importing or cloning a dedicated vault.",
                9000
            );
            return;
        }

        const currentVaultPath = path.resolve(adapter.getBasePath());
        const parentDir = path.dirname(currentVaultPath);
        const suggestedPath = path.join(
            parentDir,
            getSuggestedApiVaultName(this.plugin.settings)
        );

        const requestedPath = await new GeneralModal(concretePlugin, {
            placeholder:
                "Choose a folder for the imported vault (absolute path or sibling name)",
            initialValue: suggestedPath,
        }).openAndGetResult();
        if (!requestedPath) return;

        // Validate the user-supplied path before resolving it on disk.
        // path.resolve on un-validated input can construct arbitrary filesystem
        // paths (e.g. "../../etc/cron.d/evil") that then get mkdir'd.
        const targetDir = sanitizeVaultTargetPath(requestedPath, parentDir);
        if (!targetDir) {
            this.plugin.makeSyncNotice(
                "Git Vault: target path contains invalid or unsafe path segments.",
                7000
            );
            return;
        }

        if (
            targetDir === currentVaultPath ||
            targetDir.startsWith(`${currentVaultPath}${path.sep}`) ||
            currentVaultPath.startsWith(`${targetDir}${path.sep}`)
        ) {
            this.plugin.makeSyncNotice(
                "Git Vault: dedicated vault import must target a directory outside the currently open vault.",
                7000
            );
            return;
        }

        try {
            const stat = await fsPromises.stat(targetDir);
            if (stat.isDirectory()) {
                const entries = await fsPromises.readdir(targetDir);
                if (entries.length > 0) {
                    this.plugin.makeSyncNotice(
                        "Git Vault: target directory already exists and is not empty.",
                        7000
                    );
                    return;
                }
            } else {
                this.plugin.makeSyncNotice(
                    "Git Vault: target path exists and is not a directory.",
                    7000
                );
                return;
            }
        } catch (error) {
            if (
                !(error instanceof Error) ||
                !("code" in error) ||
                (error as NodeJS.ErrnoException).code !== "ENOENT"
            ) {
                throw error;
            }
            try {
                await fsPromises.mkdir(targetDir, { recursive: true });
            } catch (mkdirError) {
                const msg =
                    mkdirError instanceof Error
                        ? mkdirError.message
                        : String(mkdirError);
                this.plugin.makeSyncNotice(
                    `Git Vault: failed to create target directory – ${msg}`,
                    7000
                );
                return;
            }
        }

        const progressModal = new SetupProgressModal(
            concretePlugin.app,
            "Setting up dedicated vault"
        );
        progressModal.open();

        try {
            progressModal.setStatus("Cloning repo…");
            const written = await provider.exportRemoteToDirectory(targetDir);

            const bootstrapService = new VaultBootstrapService(concretePlugin);
            const result = await bootstrapService.bootstrapDedicatedVault(
                targetDir,
                (message) => progressModal.setStatus(message)
            );

            progressModal.close();
            new VaultBootstrapModal(concretePlugin.app, {
                mode: "success",
                vaultPath: result.vaultPath,
                registeredInSwitcher: result.registeredInSwitcher,
                onOpenVault: () => bootstrapService.openVault(result.vaultPath),
            }).open();
            this.plugin.makeSyncNotice(
                `Git Vault: imported ${written} file(s) into ${targetDir}.`,
                7000
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const failureMsg = `Git Vault: import failed – ${msg}`;
            console.error("[Git Vault] exportRemoteToDirectory failed:", err);
            progressModal.markFailed(failureMsg);
            this.plugin.makeSyncNotice(failureMsg, 9000);
        }
    }
}
