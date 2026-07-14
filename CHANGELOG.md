# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## Unreleased

### Android compatibility

- Stopped the desktop pending-vault hand-off from calling Node's `path.resolve` during mobile startup (`Je.resolve is not a function`).
- Pinned and patched the browser build of isomorphic-git so packfile SHA-1 validation copies typed-array ranges before hashing them. This avoids false `Packfile payload corrupted` failures in affected Android/iOS WebViews.
- Fixed mobile binary writes so typed-array views are copied into exact-range ArrayBuffers before Obsidian stores Git packfiles, and added one automatic isolated-cache rebuild/retry when an old corrupted pack is detected.
- Mobile Forgejo commits now receive an explicit author identity, reusing configured Git author values when available and falling back to the Forgejo owner/device identity when the isolated repository has no `user.name` or `user.email`.
- Added a non-zero-offset Web Crypto capability check and made the pnpm build-script allowlist reproducible on clean installs.

### Forgejo sync rewrite

- Replaced the per-file Gitea/Forgejo REST sync data path with Git smart HTTP: mandatory system Git on desktop and an isolated isomorphic-git worktree on mobile.
- A sync now uses one fetch, a true base/local/remote three-way merge, at most one local content commit, and one push.
- Added transactional rollback for vault files and local Git refs/index, atomic visual conflict resolution, and hard exclusions for `.obsidian`, `.git`, and `.cocoindex_code`.

### Fork maintenance

- Rebranded repository metadata and documentation for the Dream-Wood edition while retaining MIT upstream attribution.
- Added a dedicated Forgejo architecture, setup, migration, and troubleshooting guide.
- Removed Dependabot configuration; dependency updates are maintained manually in this fork.

## 1.0 (2026-04-13)

### Features

### Migration / Breaking changes

- Removed the embedded askpass helper and runtime `obsidian_askpass.sh`. The plugin no longer sets `SSH_ASKPASS` or provides an internal GUI askpass prompt. Users should configure a system credential helper (for example Git Credential Manager, macOS Keychain, or an SSH agent) to handle HTTPS or SSH authentication. See `README.md` and `src/gitManager/simpleGit.ts` for migration and troubleshooting steps.
