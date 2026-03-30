# Quilltap Electron Shell Changelog

## 4.0.1

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

