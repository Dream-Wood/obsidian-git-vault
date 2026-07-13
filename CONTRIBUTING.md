# Contributing to the Dream-Wood Edition

Thank you for improving Obsidian Git Vault. This repository is a maintained fork
with a Forgejo-specific transaction engine. Issues and pull requests for this
edition belong at
[Dream-Wood/obsidian-git-vault](https://github.com/Dream-Wood/obsidian-git-vault).

## Before Opening a Pull Request

1. Open an issue for changes that alter sync semantics, repository layout,
   conflict behavior, credential handling, or the settings UX.
2. Never commit tokens, passwords, credential-bearing URLs, vault data, or
   `.obsidian` runtime state.
3. Preserve the `SyncProvider` / `SyncManager` boundary and keep
   provider-specific behavior explicit.
4. Add focused unit tests for every sync or conflict regression.
5. Update user documentation when behavior, requirements, or migration steps
   change.

## Local Setup

```bash
git clone https://github.com/Dream-Wood/obsidian-git-vault.git
cd obsidian-git-vault
pnpm install
pnpm run build
```

Useful checks:

```bash
pnpm run tsc
pnpm run svelte
pnpm run lint
pnpm run format
pnpm run test
```

`make check` runs the repository-wide verification set. Copy `main.js`,
`manifest.json`, and `styles.css` into a disposable test vault for manual
Obsidian verification.

## Forgejo Invariants

Changes to `ForgejoGitSyncProvider` or its transports must preserve:

- one fetch per normal sync transaction;
- a content-based three-way merge against the stored base ref;
- at most one local content commit and one push;
- no vault writes before conflicts are resolved;
- rollback of local files and Git transaction state on failure;
- hard exclusion of `.obsidian`, `.git`, and `.cocoindex_code`;
- native system Git on desktop and isolated isomorphic-git on mobile;
- no credentials in logs, command arguments, remotes, or committed fixtures.

Add or update tests in `tests/unit/forgejoThreeWayMerge.test.ts` and
`tests/unit/forgejoGitSyncProvider.test.ts` when these invariants are affected.

## Attribution

Do not remove existing copyright notices or upstream attribution. New original
work in this fork remains under the repository's MIT License. See
[NOTICE.md](NOTICE.md).
