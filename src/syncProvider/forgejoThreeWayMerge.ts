import diff3Merge from "diff3";
import type { Conflict } from "./syncProvider";

export type ForgejoSnapshot = Map<string, Uint8Array>;

export interface ForgejoMergeResult {
    merged: ForgejoSnapshot;
    conflicts: Conflict[];
    changedPaths: string[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function bytesEqual(
    left: Uint8Array | undefined,
    right: Uint8Array | undefined
): boolean {
    if (left === right) return true;
    if (!left || !right || left.byteLength !== right.byteLength) return false;
    for (let i = 0; i < left.byteLength; i++) {
        if (left[i] !== right[i]) return false;
    }
    return true;
}

function splitLines(value: string): string[] {
    return value.match(/.*(?:\n|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function decodeText(value: Uint8Array | undefined): string | undefined {
    if (!value) return undefined;
    try {
        if (value.includes(0)) return undefined;
        return decoder.decode(value);
    } catch {
        return undefined;
    }
}

function mergeText(
    local: Uint8Array,
    base: Uint8Array,
    remote: Uint8Array
): Uint8Array | null {
    const localText = decodeText(local);
    const baseText = decodeText(base);
    const remoteText = decodeText(remote);
    if (
        localText === undefined ||
        baseText === undefined ||
        remoteText === undefined
    ) {
        return null;
    }

    const chunks = diff3Merge(
        splitLines(localText),
        splitLines(baseText),
        splitLines(remoteText)
    );
    if (chunks.some((chunk) => "conflict" in chunk)) return null;
    return encoder.encode(
        chunks.flatMap((chunk) => ("ok" in chunk ? chunk.ok : [])).join("")
    );
}

/**
 * Merge two complete file snapshots against their last successfully published
 * common base. No timestamps are used: every decision follows Git's normal
 * three-way rules, including delete/modify conflicts.
 */
export function mergeForgejoSnapshots(
    base: ForgejoSnapshot | null,
    local: ForgejoSnapshot,
    remote: ForgejoSnapshot
): ForgejoMergeResult {
    const merged: ForgejoSnapshot = new Map();
    const conflicts: Conflict[] = [];
    const paths = new Set<string>([
        ...(base?.keys() ?? []),
        ...local.keys(),
        ...remote.keys(),
    ]);

    for (const path of [...paths].sort()) {
        const ancestor = base?.get(path);
        const ours = local.get(path);
        const theirs = remote.get(path);

        if (bytesEqual(ours, theirs)) {
            if (ours) merged.set(path, ours);
            continue;
        }
        if (!base && ours && !theirs) {
            merged.set(path, ours);
            continue;
        }
        if (!base && theirs && !ours) {
            merged.set(path, theirs);
            continue;
        }
        if (base && bytesEqual(ancestor, theirs)) {
            if (ours) merged.set(path, ours);
            continue;
        }
        if (base && bytesEqual(ancestor, ours)) {
            if (theirs) merged.set(path, theirs);
            continue;
        }

        if (ancestor && ours && theirs) {
            const autoMerged = mergeText(ours, ancestor, theirs);
            if (autoMerged) {
                merged.set(path, autoMerged);
                continue;
            }
        }

        const localText = decodeText(ours);
        const remoteText = decodeText(theirs);
        const baseText = decodeText(ancestor);
        const isBinary =
            (ours !== undefined && localText === undefined) ||
            (theirs !== undefined && remoteText === undefined) ||
            (ancestor !== undefined && baseText === undefined);
        conflicts.push({
            path,
            localContent: isBinary ? ours : localText,
            remoteContent: isBinary ? theirs : remoteText,
            baseContent: isBinary ? ancestor : baseText,
            isBinary,
            deletedLocal: ours === undefined,
            deletedRemote: theirs === undefined,
            requiresManualResolution: isBinary,
        });
    }

    return {
        merged,
        conflicts,
        changedPaths: [...paths]
            .filter((path) => !bytesEqual(merged.get(path), remote.get(path)))
            .sort(),
    };
}

export function snapshotsEqual(
    left: ForgejoSnapshot,
    right: ForgejoSnapshot
): boolean {
    const paths = new Set([...left.keys(), ...right.keys()]);
    return [...paths].every((path) =>
        bytesEqual(left.get(path), right.get(path))
    );
}
