# Forgejo Git Sync

The Dream-Wood edition uses the normal Git smart-HTTP protocol for Forgejo
content sync. It does not upload or download vault files through the Gitea
contents API.

This backend is shown as **Forgejo Git** in plugin settings.

## Platform Transport

| Platform | Transport | Local repository |
| --- | --- | --- |
| Windows, macOS, Linux | System Git executable | Real repository at the configured vault/base path |
| Android, iOS | isomorphic-git | Isolated worktree under `.obsidian/.git-vault-mobile/<target>` |

Desktop startup verifies that Git is available before Forgejo sync is enabled.
On Windows, install Git for Windows and configure Git Credential Manager. The
plugin deliberately does not put a Forgejo token in command arguments or clone
URLs.

Mobile uses the Forgejo personal access token stored by Obsidian. The isolated
worktree keeps Git checkout/index operations away from user files and the live
Obsidian configuration.

## Sync Transaction

One successful sync transaction performs:

1. Read a local snapshot containing only files inside the configured scope.
2. Run one `fetch` for the selected Forgejo branch.
3. Read the last successful base snapshot and the fetched remote snapshot.
4. Merge base, local, and remote contents with normal three-way rules.
5. If the merge is clean, update the local worktree transactionally.
6. Create at most one local content commit.
7. Run one `push` when a new commit exists.
8. Move `refs/git-vault/forgejo-base` only as part of the successful transaction.

If the remote changed but there are no local changes, the plugin applies the
remote snapshot without creating an unnecessary commit or push.

## Conflicts and Atomicity

The engine compares content, not filesystem modification time. For every
conflict the existing resolver receives:

- the common base;
- the local version;
- the remote version;
- delete/modify and binary-file information.

When conflicts are found, no vault file is changed. The user can keep local,
keep remote, or provide manually merged content. All selected resolutions are
published together as one transaction.

Before publication the engine keeps the original vault snapshot and Git state.
If staging, commit, base-ref update, or push fails, it restores vault files and
local refs. Native Git also restores the original index tree.

## Scope and Service-File Safety

Forgejo Git supports **Tracked directory** and **Excluded paths**. Unlike the
old API mapping, the tracked directory keeps its repository-relative path.

The following are always excluded regardless of user patterns:

- `.obsidian/`
- `.git/`
- `.cocoindex_code/`

Changes outside the selected scope do not trigger file-change sync. The plugin
also does not poll `.obsidian` for Forgejo, avoiding fetches caused by workspace,
cache, or plugin-state writes.

If an older API build already uploaded `.obsidian` files, the new engine ignores
and preserves those remote entries. Remove them manually once if they should no
longer exist in repository history.

## First Sync

The first successful sync creates `refs/git-vault/forgejo-base` locally.

- A path that exists only locally or only remotely is accepted.
- Identical local and remote files are accepted.
- Different local and remote contents at the same path are surfaced as a
  conflict because there is no trustworthy common base yet.

This conservative bootstrap prevents the first sync from silently overwriting
one side.

## Authentication

### Desktop

Use the operating system's Git credential helper:

```bash
git --version
git config --global credential.helper
```

For Git for Windows the expected helper is normally `manager`. Authenticate once
with a regular `git fetch` or `git push` against the Forgejo repository before
using automatic sync.

The token in the Forgejo settings remains useful for repository/branch discovery
in the UI, but desktop Git transport authentication belongs to the credential
helper.

### Mobile

Create a Forgejo token with repository content read/write access and save it in
the Forgejo provider settings. isomorphic-git sends it through HTTPS
authentication. SSH is not supported on the mobile transport.

## Migration from the API Engine

1. Back up the vault and make sure the remote repository is accessible.
2. Update the plugin and select **Forgejo Git**.
3. Disable API payload encryption for this repository; Forgejo Git stores normal
   Git blobs and does not support that API-only envelope format.
4. Configure server URL, owner, repository, and branch.
5. On desktop, verify `git --version` and credential-helper access.
6. Run sync and review any conservative first-sync conflicts.
7. After a clean sync, inspect the single resulting commit in Forgejo.

Do not delete the local `.git` directory or the mobile isolated worktree while a
sync is running.

## Expected Forgejo Load

The old Gitea path traversed repository contents and could perform many per-file
requests and commits. The new data path uses one Git fetch pack and, when local
content changed, one pushed commit. Repository discovery in Settings can still
use the Forgejo API, but it is outside the content-sync transaction.
