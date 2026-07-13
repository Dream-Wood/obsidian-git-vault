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
