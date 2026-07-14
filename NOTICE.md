# Attribution and Fork Notice

This repository is the Dream-Wood edition of **Obsidian Git Vault**. It is a
substantially modified fork of
[redoracle/obsidian-git-vault](https://github.com/redoracle/obsidian-git-vault),
which itself builds on the earlier Obsidian Git work by Vinzent03 and Denis
Olehov.

The project remains available under the MIT License. Existing copyright
notices have been retained in [LICENSE](LICENSE); Dream-Wood is identified as
the copyright holder for original modifications made in this fork.

## Major Dream-Wood changes

- Replaced the Gitea/Forgejo per-file REST sync data path with Git smart HTTP.
- Added mandatory system-Git detection and native Git transport on desktop.
- Added an isolated isomorphic-git worktree for Forgejo sync on mobile.
- Added a mobile Web Crypto compatibility patch for isomorphic-git packfile
  SHA-1 validation; the dependency remains under its upstream MIT license.
- Added a one-fetch, true three-way merge transaction with at most one local
  content commit and one push.
- Added atomic conflict handling and rollback of vault files, refs, and the
  native Git index when publication fails.
- Hard-excluded `.obsidian`, `.git`, and `.cocoindex_code` from Forgejo content
  sync and removed service-file changes as Forgejo sync triggers.
- Retained the existing UI, provider selection, smart triggers, history, diff,
  and conflict-resolution surfaces while routing Forgejo through the new engine.

Upstream authors do not endorse or provide support for Dream-Wood-specific
changes. Please report issues with this edition in the
[Dream-Wood issue tracker](https://github.com/Dream-Wood/obsidian-git-vault/issues).
