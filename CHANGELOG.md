# Quilltap Electron Shell Changelog

## 4.1.6

### Features

- **Release workflow falls back to unsigned installers**: `scripts/release/build-electron.ts` now detects per-platform signing credentials (mac: `CSC_LINK` + `CSC_KEY_PASSWORD` + Apple API key vars; win: Azure Trusted Signing trio; linux: never signs). When credentials are present it attempts a signed build first; on failure it wipes `out/`, re-runs electron-builder with signing disabled, and renames the resulting `.dmg` / `.zip` / `.exe` files to insert `-unsigned` before the extension. `latest-mac.yml` / `latest.yml` are patched in place so the auto-updater feed references the renamed filenames. `create-github-release.ts` now treats all three platforms as required — the release fails with a clear list of missing platforms if any produced zero installers — and prepends a flavored notice to the release body whenever any `-unsigned` artifact is present, explaining how to coax macOS Gatekeeper and Windows SmartScreen past the velvet rope. The workflow's `create-release` gate is now `if: !cancelled()`, deferring sufficiency to the script; `continue-on-error: true` was removed from the Windows job now that Windows contributes to release viability the same as the other platforms.

## 4.1.5

### Features

- **"Change Settings…" escape hatch in the splash error pane**: The error state on the splash screen used to offer only Retry and Quit. Retry blindly reran `routeStartup(appSettings.lastDataDir)` with the same `serverVersion`, so a startup error like a `minServerVersion` mismatch became an infinite loop with Quit as the only out (or a 5-second window to click "Change data directory…" in the loading state on the next launch). A new middle button now routes back to the directory chooser via the existing `showDirectoryChooser` IPC, letting users pick a different server version, runtime, or instance without quitting.

### Maintenance

- **Electron 40 → 41.7.0**: Chromium 144 → 146, V8 ABI 143 → 145, Node runtime unchanged at 24.15.0. Native modules (`better-sqlite3-multiple-ciphers`, `sharp`) rebuilt against the new ABI. Electron 42 was attempted first but blocked by a V8 `ExternalPointerTypeTag` change that `better-sqlite3-multiple-ciphers@12.9.0` has not yet picked up (upstream `better-sqlite3` already shipped the fix in 12.10.0); revisit when the fork catches up.
- **TypeScript 5.7 → 6.0.3**: Major bump. `electron/tsconfig.json` migrated `module` and `moduleResolution` from `"commonjs"` / `"node"` to `"node16"` / `"node16"`, since the `"node"` resolver was deprecated in TypeScript 6 and is scheduled for removal in 7. Emit remains CommonJS (the package has no `"type": "module"`) and compiled output is shape-identical to the previous build.
- **cross-env 7.0.3 → 10.1.0**: The package went ESM-only in 10.x, but we only invoke it as a CLI binary in the `electron:dev` script, so module format is irrelevant. Its engine floor of Node ≥ 20 sits well below our `engines.node` requirement of `>=22`.
- **Other refreshed dependencies**: `better-sqlite3-multiple-ciphers` 12.8 → 12.9, `tar` 7.5.13 → 7.5.15, `yauzl` 3.2.1 → 3.3.1, `@electron/rebuild` 4.0.3 → 4.0.4.

## 4.1.4

### Features

- **Release workflow steps are now scripts**: Every meaningful step in `.github/workflows/release.yml` now delegates to a TypeScript script under `scripts/release/`, so the same logic that runs in CI can be invoked locally for troubleshooting. New scripts cover tag validation, macOS keychain bootstrap and teardown, Apple API key file management, electron-builder invocation per platform, prerelease/production detection, and `gh release create` assembly. Each script reads inputs from env vars and writes step outputs to `$GITHUB_ENV` / `$GITHUB_OUTPUT` when those are present, falling back to console output locally; `create-github-release.ts` additionally supports `--dry-run` and a configurable `ARTIFACTS_DIR` so the publish step can be rehearsed against a folder of downloaded artifacts.

## 4.1.3

### Fixes

- **Lima VM base image switched from Alpine to Debian 12**: The standalone tarball is built `FROM node:24-bookworm-slim` (glibc), but `lima/quilltap.yaml` was provisioning an Alpine 3.21 (musl) VM. The Node binary in the tarball would not exec — `start-stop-daemon` reported "No such file or directory" because `execve(2)` returns ENOENT when the ELF interpreter is missing, and Alpine has no `/lib/ld-linux-aarch64.so.1`. The yaml now uses Debian 12 nocloud images (arm64 + amd64), apt instead of apk, and a systemd unit at `/etc/systemd/system/quilltap.service` instead of the OpenRC `/etc/init.d/quilltap` script. Existing VMs created from the old yaml will need to be deleted (`limactl delete quilltap-*`) so the new template applies.

## 4.1.2

### Fixes

- **Correct ordering of numeric pre-release suffixes**: `compareVersions` previously compared pre-release suffixes with `localeCompare`, which sorts `dev.99` after `dev.100` because `'9' > '1'` lexicographically. This caused the `minServerVersion` check (and upgrade-available check) to misjudge adjacent dev builds. Suffixes are now split on `.` and compared per semver §11.4 — all-numeric segments numerically, alphanumeric lexicographically, numeric outranked by alphanumeric, shorter prefix losing to longer.

## 4.1.1

### Fixes

- **Increased server memory limit**: Raised `--max-old-space-size` from 2048 MB to 4096 MB across all launch modes (embedded, Lima, WSL2). The previous 2 GB cap was effectively V8's default and caused the server to OOM-crash within a minute of startup under normal use.

## 4.1.0

### Features

- **Server repository move support**: Updated the launcher's GitHub release source and documentation to use `foundry-9/quilltap-server` instead of the old `foundry-9/quilltap` repository. This keeps standalone server downloads and user-facing links pointed at the proper home after the repo migration.

## 4.0.17

### Features

- **Minimum server version enforcement**: The launcher now reads `minServerVersion` from each instance's `data/quilltap.dbkey` file. If the selected server version is older than the minimum, launch is blocked with a clear error message asking the user to choose a newer version. The minimum version (if any) is shown next to each instance name on the splash screen directory list, prefixed with "≥". Version comparison correctly treats pre-releases as older than their base release (e.g. `3.3.0-dev.25` < `3.3.0`).

## 4.0.16

### Fixes

- **Update check available during splash screen**: The launcher auto-update check previously only ran after the main window appeared, so users lingering on the splash screen (directory chooser) were never prompted about new versions. The check now also runs shortly after the splash screen appears. Additionally, a minimal application menu with **Help > Check for Updates…** is now set during the splash phase, so users can manually check for updates before launching a server.

### Features

- **Prerelease version filter**: Added a "Prerelease" checkbox next to the Server Version selector on the splash screen. When unchecked (the default), the "Latest Dev" option and all pre-release tagged versions are hidden from the dropdown. When checked, the checkbox and label turn bright red as a visual reminder, and the full version list (including dev builds) is shown. The setting persists across app restarts.

## 4.0.15

### Features

- **MRU instance ordering**: The instance list on the splash screen is now sorted by most-recently-used. Starting an instance moves it to the top of the list, so the instances you use most often are always within easy reach.

## 4.0.14

### Documentation

- **README rewrite**: Replaced the placeholder two-line README with comprehensive documentation covering the three runtime modes (Direct, Docker, VM), splash screen usage, data directories, server version selection, auto-update behavior, building from source, the release pipeline, and architecture notes.

### Fixes

- **Auto-update reliability**: The launcher update check now retries every 4 hours instead of running only once at startup. If the initial check fails due to a transient network error or the machine being offline, subsequent checks will still catch available updates.
- **No duplicate draft releases**: Added `--publish never` to all electron-builder invocations in the release workflow so electron-builder no longer auto-creates draft releases with `v`-prefixed tags alongside the real published releases.

### Features

- **Help menu with "Check for Updates..."**: Added a Help menu to the application menu bar. The "Check for Updates…" item lets users manually trigger an update check at any time, bypassing the "declined version" memory and always showing feedback — either the update prompt, a "you're up to date" confirmation, or an error message.

## 4.0.13

### Fixes

- **Upgrade banner not clickable**: The server version upgrade banner on the splash screen was missing `-webkit-app-region: no-drag`, so clicks on the "Update" and "Not now" buttons were swallowed by the frameless window drag handler instead of reaching the button event listeners.
- **Splash window too short for upgrade banner**: Increased splash window height from 720px to 770px to accommodate the server version upgrade banner without clipping content.

## 4.0.12

### Fixes

- **Linux release build failure**: Added missing `GH_TOKEN` environment variable to the Linux electron-builder step in the GitHub Actions release workflow. The macOS and Windows builds already had it, but the Linux build would fail because electron-builder v26 auto-publishes when it detects a git tag and requires the token.

## 4.0.11

### Features

- **Launcher auto-update**: The Quilltap Launcher now checks GitHub Releases for newer versions after the main window loads. When an update is available, a native dialog prompts the user to download and restart. Declined versions are remembered so the prompt does not reappear until a newer release is published. The update downloads with a progress indicator, gracefully stops the running server, then installs and relaunches.
- **macOS zip target**: Added a zip build target alongside the existing DMG for macOS. The zip is used by electron-updater for in-place updates; the DMG remains available for fresh installations.
- **Update metadata in releases**: The GitHub Actions release workflow now uploads `latest-mac.yml`, `latest.yml`, and `latest-linux.yml` metadata files alongside installers, enabling electron-updater to discover available versions.

## 4.0.10

### Fixes

- **Application menu name**: Set `app.name` to "Quilltap" explicitly so the macOS application menu and About dialog show the correct name instead of "quilltap-shell" (the npm package name).

## 4.0.9

### Features

- **Server version upgrade prompt**: When the user has pinned a specific server version and a newer release is available, the splash screen now shows a banner offering to upgrade. Stable users are only offered newer stable releases; dev users are offered the newest version across both channels. Declining suppresses the prompt for that version, but a newer release will prompt again.

## 4.0.8

### Features

- **Copy image to clipboard**: Added `copyImageToClipboard(dataUrl)` to the shell bridge API. The server can now copy generated images to the system clipboard via `window.quilltap.copyImageToClipboard()`. Backed by a new `app:copy-image-to-clipboard` IPC handler using Electron's `nativeImage` and `clipboard` modules.

## 4.0.7

### Fixes

- **Lima codesign no longer blocks staging**: The `stage-lima.ts` codesign step is now best-effort. If the signing identity is listed in the keychain but `codesign` still fails (e.g. due to keychain ACL issues on CI runners), the script warns and continues instead of aborting. Diagnostic output now shows available identities on mismatch.

## 4.0.6

### Fixes

- **Linux .deb build failure**: Added author email to `package.json` so `electron-builder` can populate the required maintainer field for Debian packages.
- **Lima codesign shell escaping**: Replaced `execSync` with `execFileSync` for the `codesign` call in `stage-lima.ts` so that parentheses in the signing identity (e.g. Developer ID team IDs) are not misinterpreted by `/bin/sh`.

## 4.0.5

### Features

- **Release tagging script**: Added `scripts/tag-release.sh` which reads the version from `package.json`, creates an annotated git tag, and pushes it to origin. Includes safety checks for existing tags and dirty working trees.

## 4.0.4

### Features

- **Release workflow**: Added GitHub Actions workflow that builds and signs the Electron shell for macOS (code signing + Apple notarization), Windows (Azure Trusted Signing), and Linux on semver tag push. Creates a GitHub Release with DMG, NSIS installer, AppImage, and deb artifacts.

## 4.0.3

### Features

- **Shell identity env vars**: The shell now passes `QUILLTAP_SHELL` (version string) and `QUILLTAP_SHELL_CAPABILITIES` (comma-delimited capability flags) to the server in all launch modes — embedded, Docker (`-e`), Lima (template placeholders), and WSL2 (inherited env). The canonical capabilities value lives in `SHELL_CAPABILITIES` in `electron/constants.ts`. Capabilities are empty for now, awaiting future flags like `OPENS_FS_PATH` and `DOWNLOADS_FILE`.

## 4.0.2

### Fixes

- **Lima binary bundling**: Restored the `stage-lima.ts` build script that downloads Lima binaries from GitHub Releases and stages them into the Electron app bundle. Without this, packaged builds had no `limactl` binary and Lima mode could not start. Added `electron:stage-lima` npm script and wired it into the macOS build pipeline. The `electron-builder.yml` now includes the staged binaries directory as an `extraResources` entry alongside the existing Lima template YAML.

## 4.0.1

### Features

- **Version selector for all runtime modes**: The server version dropdown now appears for Docker and VM (Lima/WSL2) modes, not just embedded/direct mode. Each mode filters available versions by the assets that exist for it (standalone tarballs for embedded, rootfs tarballs for VM, all tagged releases for Docker). Switching runtime modes refreshes the version list automatically.
- **Docker version selection**: Docker mode now pulls the user-selected version tag from `foundry9/quilltap` instead of being locked to the Electron app version. Falls back to the app version if offline.
- **VM version selection**: VM mode now downloads the rootfs tarball for the user-selected version instead of being locked to the app version. Falls back to the app version if offline.

### Fixes

- **Native module copy from asar**: Replaced `fs.cpSync` with a recursive read/write copy that works when source modules are inside Electron's asar archive, fixing packaged builds failing to copy `sharp` and other JS modules into the standalone server directory.
- **Force-overwrite native modules**: Native modules (`better-sqlite3`, `sharp`, `@img/*`) are now always overwritten regardless of version match, since the tarball ships Node.js ABI binaries that must be replaced with Electron ABI binaries.
- **Copy all `@img` packages**: The `@img` copy filter no longer skips non-platform packages like `@img/colour`, which is a required dependency of `sharp`.
- **Asar path resolution**: `resolveModuleDir` now prefers `app.asar.unpacked` when available (for native binaries) and falls back to the asar path (for pure-JS modules), instead of blindly rewriting all paths to unpacked.
- **Embedded server logging**: Server stdout/stderr is now written to `embedded-server.log` in the data directory's logs folder, making it possible to diagnose server errors when not running from a terminal.
- **Renderer error forwarding**: Console warnings/errors, resource load failures, and renderer process crashes are forwarded from the renderer to the main process for diagnostics.

## 4.0.0

### Features

- **Server version selector**: Dropdown in the splash screen directory chooser (visible in Direct/embedded mode) lets you choose which Quilltap server version to run — Latest Release, Latest Dev, or a specific tag. Fetched from GitHub Releases API, filtered to versions >= 3.2.0.
- **Build script for native modules**: `scripts/rebuild-native-modules.ts` rebuilds better-sqlite3 and installs platform-specific sharp binaries against Electron's Node ABI at build time, so no local Node.js is needed at runtime.
- **Server cache cleanup**: `npm run clean:server-cache` removes the downloaded standalone server cache.

### Fixes

- **Native module ABI mismatch**: Native modules are now rebuilt against Electron's headers during the build process, fixing the `NODE_MODULE_VERSION` mismatch that prevented the embedded server from starting.
- **Native module copy (not symlink)**: Copies native modules from `app.asar.unpacked` into the standalone directory instead of symlinking, fixing transitive dependency resolution issues (`bindings`, `file-uri-to-path`).
- **Broken symlink cleanup**: Uses `lstatSync` instead of `existsSync` to detect and remove stale/broken symlinks before re-linking.
- **Fatal error detection**: The embedded startup sequence now detects fatal server errors (version guard blocks, migration failures, module-not-found) from structured JSON log output and aborts the health check loop immediately instead of polling for 2 minutes.
- **Health checker abort**: `waitForHealthy()` accepts a `shouldAbort` callback to exit early when the server is known to be in an unrecoverable state.
- **Error screen usability**: Error container is no longer draggable (`-webkit-app-region: no-drag`) and error text is selectable/copyable (`user-select: text`).

### Build Changes

- All `electron:build:*` scripts now run `electron:rebuild-native` before packaging.
- `electron-builder.yml` updated to include `bindings` and `file-uri-to-path` in the packaged app, and corrected the `better-sqlite3` alias directory name.
- Added `@electron/rebuild` as a dev dependency.
- Version bumped to 4.0.0.
