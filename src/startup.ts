import type { SyncProviderSetting } from "./types";

export function requiresLocalGitRepo(
    activeSyncProvider: SyncProviderSetting
): boolean {
    return activeSyncProvider === "git" || activeSyncProvider === "gitea";
}

export function shouldUseNativeGit(
    activeSyncProvider: SyncProviderSetting,
    isDesktopApp: boolean
): boolean {
    return isDesktopApp && requiresLocalGitRepo(activeSyncProvider);
}

export function shouldPollConfigDirectory(
    activeSyncProvider: SyncProviderSetting
): boolean {
    return activeSyncProvider === "github" || activeSyncProvider === "gitlab";
}

/**
 * Pending dedicated-vault hand-offs contain absolute filesystem paths and are
 * created only by the desktop bootstrap flow. Mobile adapters may expose a
 * base-path-shaped value, but Node's `path` module is not available there.
 */
export function shouldConsumePendingVaultSyncRequest(
    isDesktopApp: boolean,
    basePath: string | null
): basePath is string {
    return isDesktopApp && typeof basePath === "string" && basePath.length > 0;
}

export function getPausedAutomaticsResumeDelay(
    pausedUntil: number | null,
    now: number = Date.now()
): number | null {
    if (pausedUntil === null) {
        return null;
    }

    const delay = pausedUntil - now;
    return delay > 0 ? delay : null;
}
