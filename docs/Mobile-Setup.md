# Mobile Setup

Obsidian Git Vault works on iOS and Android without a native Git binary or external terminal.

Choose one of two mobile paths:

- **Forgejo Git:** isolated isomorphic-git worktree, one fetch, real three-way merge, at most one commit and one push.
- **GitHub/GitLab API:** repository API transport with API-specific features such as payload encryption.

Simple UI mode is recommended for both.

---

## Prerequisites

- Obsidian installed on your iOS or Android device.
- A repository on Forgejo, GitHub, or GitLab (private recommended).
- A provider token with repository content read/write permission.
- For Forgejo, the server URL, owner, repository, and target branch.

---

## Step-by-Step Setup

### 1. Install the Plugin

1. Open Obsidian on your mobile device
2. Go to **Settings → Community Plugins → Browse**
3. Search for **Obsidian Git Vault** and tap **Install**, then **Enable**

> If the plugin is not yet in the community directory, install it manually:
> Download the Dream-Wood edition from [GitHub Releases](https://github.com/Dream-Wood/obsidian-git-vault/releases), copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/git-vault/` in your vault (via Files app, iSH, or another transfer method), then enable it in Settings.

### 2. Configure the Plugin

Go to **Settings → Obsidian Git Vault**, choose **Simple** UI mode, then configure one provider.

For Forgejo:

| Field | Value |
| --- | --- |
| Sync Backend | `Forgejo Git` |
| Server URL | Base URL such as `https://git.example.com` |
| Token | Forgejo token with repository read/write access |
| Owner | User or organization owning the repository |
| Repository | Repository name |
| Branch | `main` or another selected branch |

For GitHub API:

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| Sync Backend      | `GitHub API` _(pre-selected)_          |
| GitHub Token      | Your personal access token             |
| GitHub Owner      | Your GitHub username or organisation   |
| GitHub Repository | The repository name (not the full URL) |
| GitHub Branch     | `main` (or your branch)                |

### 3. First Sync

Open the **Source Control** panel (tap the sidebar icon or use the command palette → "Open source control view") and tap **Sync**.

On the first Forgejo run, local-only and remote-only paths are combined. Different contents at the same path are intentionally shown as conflicts because there is no common base yet. Review them rather than forcing an overwrite.

### 4. Enable Smart Triggers (Recommended)

Go to **Settings → Obsidian Git Vault → Smart sync triggers** and enable:

-   ✅ **Sync on network reconnect** — syncs when you switch from offline to online
-   ✅ **Sync on close** — syncs when you background the app
-   ☐ **Sync on file change** — enable if you want real-time sync (use a debounce ≥ 10 000 ms on mobile)

---

## Syncing Across Devices (Desktop + Mobile)

1. Set up Git or Forgejo Git on desktop (see [Getting Started](Getting%20Started.md)).
2. Select the same repository and branch on mobile.
3. Sync before switching devices.
4. Forgejo creates at most one content commit per mobile sync; GitHub/GitLab behavior follows their API provider.

> Avoid editing the same note on two offline devices. Forgejo detects this with a real three-way conflict and leaves the vault unchanged until you resolve it.

---

## Troubleshooting

### "401 Unauthorized" or "403 Forbidden"

The provider token is invalid, expired, or lacks repository content permission. Regenerate it in Forgejo/GitHub/GitLab and update it in Settings.

### "404 Not Found" for the repository

Double-check the server URL, owner, repository, and branch. They are case-sensitive and must match the remote exactly.

### Sync is very slow on first run

The first fetch and snapshot comparison must inspect the repository once. Subsequent Forgejo syncs still use one fetch but push only when the merged content differs from remote.

### App crashes or runs out of memory

If your vault is extremely large (> 10,000 files), use **Tracked directory** and **Excluded paths** to reduce the snapshot. Forgejo's mobile repository is isolated under `.obsidian/.git-vault-mobile`.

### Conflict after editing on two devices simultaneously

See [Conflict-Resolution.md](Conflict-Resolution.md). Set **Conflict Resolution Strategy** to `last-write-wins` for the most seamless experience across two personal devices.

---

## Known Limitations on Mobile

| Limitation                          | Notes                                       |
| ----------------------------------- | ------------------------------------------- |
| No SSH authentication               | Mobile transports use HTTPS tokens          |
| Branch changes are explicit         | Select and hydrate the configured branch    |
| No commit history browser           | Use desktop Advanced Mode to review history |
| No submodule support                | Desktop-only feature                        |
| No editor signs / gutter indicators | Desktop-only feature                        |

See [Forgejo Sync](Forgejo-Sync.md) for transaction, safety, authentication, and migration details.
