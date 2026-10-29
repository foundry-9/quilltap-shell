# better-sqlite3-multiple-ciphers 13 — Shell-side Spec

**Status:** Ready to implement
**Repo:** quilltap-shell only
**Target release:** 4.2.5 (patch; 4.2.4 is tagged)
**Written:** 2026-10-28, against shell 4.2.4 (Electron 41.10.7, N-API 10), server `main` at `4.12.0-dev`
**Companion:** [better-sqlite3-multiple-ciphers-v13-shell-notes.md](better-sqlite3-multiple-ciphers-v13-shell-notes.md) is the research this spec is built on. The server-side spec of record lives in the server repo at `docs/developer/features/better-sqlite3-multiple-ciphers-v13.md`. Nothing in either blocks this work, and this work blocks nothing on the server side.

## How to run this spec

This spec is written for a Claude Code session running under Opus, following the repo's CLAUDE.md: plan in Opus, delegate the work packages below to Haiku agents with specific instructions, and use worktree isolation for agents that write files. The packages are sized so one agent owns one set of files and no two writers touch the same file.

Dependency order:

1. **WP1** first, alone. Everything else needs v13 installed in `node_modules`.
2. **WP2, WP3, WP4, WP5, WP6** in parallel once WP1 has landed. Their file sets are disjoint (see each package's "Files" line).
3. **WP7** last, run by the orchestrator, not an agent. It is the acceptance pass.

Standing rules for this work:

- Type-check with `npm run typecheck`. Never run bare `tsc` against a single file.
- Leave no stubs or TODOs.
- Do not add a compatibility gate of any kind: no capability flag, no health-status branch, no `.dbkey` field, no version refusal. That was decided by the user on 2026-10-28 and the server spec records the same decision.
- `QUILLTAP_SHELL` and `QUILLTAP_SHELL_CAPABILITIES` are unchanged.
- All user-facing prose (the CHANGELOG entry) is in the house voice. Code comments and this spec are plain technical English.

## Summary

The shell today compiles `better-sqlite3-multiple-ciphers` 12 from source against Electron's headers at build time, because v12 is a V8-coupled addon whose npm prebuild targets plain Node's ABI, not Electron's. v13 (`13.0.3`, 2026-08-07) is a Node-API addon that ships a prebuilt binary for every supported platform inside the npm tarball, loads under Electron 41 unchanged, and has no install script. The compile step, the ABI-clobber ordering hazard, and the `node-gyp`/Electron-headers machinery all go away.

The only forcing function is mechanical: `scripts/check-server-alignment.ts` compares the shell's installed driver against the server repo's declared range at the head of every local `electron:build:*`. The server repo's `package.json` already says `npm:better-sqlite3-multiple-ciphers@^13.0.3`, so **every local shell build currently fails that guard**. CI does not run the guard and would still ship v12, which still works, but silently out of alignment.

Compatibility is a non-issue, verified both ways: a 4.12 server runs on the v12 driver (no v13-only API is used, and the server repo carries a rule not to until the shell ships v13), and databases written by either driver open cleanly in the other.

## Verified state (2026-10-28)

All of the following were checked directly, not taken from the notes.

| Fact | Evidence |
|---|---|
| Server repo (`../quilltap-server`) declares `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@^13.0.3"` in `package.json:84` and `"better-sqlite3-multiple-ciphers": "^13.0.3"` in `packages/quilltap/package.json:40`. | `ggrep -n better-sqlite3 ../quilltap-server/package.json` |
| The v13 tarball contains exactly eight prebuilds named `prebuilds/<platform>-<arch>.node`: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `linuxmusl-arm64`, `linuxmusl-x64`, `win32-arm64`, `win32-x64` (2.2–3.2 MB each). It also ships `binding.gyp`, `deps/sqlite3/sqlite3.c` (13.0 MB), and `src/**` (compile-time only). 68 files, 34.4 MB unpacked. | `npm pack --dry-run better-sqlite3-multiple-ciphers@13.0.3` |
| v13 manifest: `main: lib/index.js`; `exports` maps `.`, `./<platform>-<arch>`, `./package.json` only; `gypfile: false`; no `install` script; sole dependency `node-addon-api@^8.0.0`; `engines.node >= 22`. | `npm view better-sqlite3-multiple-ciphers@13.0.3` |
| In the shell's lockfile, `bindings` is depended on only by `better-sqlite3`, `file-uri-to-path` only by `bindings`, and `prebuild-install` only by `better-sqlite3`. All three leave the tree when v13 lands. | `package-lock.json` walk |
| `@electron/rebuild` (devDependency `^4.2.0`) is referenced nowhere in the repo except `package.json` and a comment in `electron-builder.yml`. `npmRebuild: false` is set, and the rebuild script shells out to `node-gyp`, not to it. Safe to remove. | `ggrep -rn "electron/rebuild"` |
| electron-builder's unpack detector (`app-builder-lib/out/asar/unpackDetector.js`) marks a module's **entire root directory** for `app.asar.unpacked/` as soon as any file in it has a `.node`, `.dll`, `.so`, `.dylib`, or `.exe` extension. The 4.2.3 build unpacked all 66 entries of `node_modules/better-sqlite3/` for that reason. A `prebuilds/darwin-arm64.node` triggers the same rule, so **no `asarUnpack` entry is expected to be needed.** WP3 verifies rather than assumes. | Read the detector; `unzip -l out/Quilltap-4.2.3-arm64.zip` |
| The embedded server is spawned as `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (`electron/embedded-manager.ts:159`). The build-time probe in WP2 must use the same mode, as the current Step 3 already does. | Read |
| The server logs `SQLCipher driver loaded { driverVersion, sqliteVersion }` at info level right after opening the main database (`lib/database/backends/sqlite/client.ts`, `logDriverVersions`). That line appears in `embedded-server.log` and is how WP7 confirms which driver ran. | Read in server repo |
| CLAUDE.md's project overview item 1 already says the shell will "install the correct platform-specific Node.js modules". It needs no change. | Read |

## Non-goals

- No shell/server handshake, flag, or refusal (see Standing rules).
- No change to `scripts/check-server-alignment.ts`. It is already correct and passes once both sides say 13.
- No addition of the alignment guard to CI. CI has no server checkout; the guard would skip with a notice. Out of scope.
- No Electron bump. The v13 move removes the reason Electron 42 was blocked (the fork's V8 coupling), but that is a separate task with its own testing.
- No server-repo changes.
- No change to Docker or Remote mode. Docker images carry their own driver; Remote mode never touched one.

## WP1 — Dependency bump

**Files:** `package.json`, `package-lock.json`. The orchestrator also bumps `version` to `4.2.5` here so that no second agent edits `package.json`.

1. In `dependencies`, change `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@^12.11.1"` to `"npm:better-sqlite3-multiple-ciphers@^13.0.3"`.
2. In `allowScripts`, replace the `"better-sqlite3-multiple-ciphers@12.11.1": true` key with `"better-sqlite3-multiple-ciphers": false` (the same deny the server repo uses). Keep the `electron` and `electron-winstaller` keys. *Implementation note (2026-10-28):* v13 declares no install script, but it ships `binding.gyp`, so npm infers an implicit `install: node-gyp rebuild`. Without the deny, `npm ci` warns that the script is not covered by `allowScripts` and runs it: node-gyp configures and leaves a `build/` directory of Makefiles and empty stamps (the gyp file skips compilation when a prebuild exists). The explicit deny keeps node-gyp out of the install entirely.
3. In `devDependencies`, delete `"@electron/rebuild"`.
4. Set `"version": "4.2.5"`.
5. Run `npm install`. Then confirm:
   - The install printed no compiler output (no `node-gyp`, no `make`, no `CXX`).
   - `node_modules/better-sqlite3/package.json` reports name `better-sqlite3-multiple-ciphers`, version `13.0.3` or later within `^13.0.3`.
   - `node_modules/better-sqlite3/prebuilds/` contains eight `.node` files.
   - `node_modules/better-sqlite3/build/` does not exist (a stale v12 compile would leave one; if it does exist, `rm -rf node_modules/better-sqlite3 && npm install`).
   - `node_modules/bindings`, `node_modules/file-uri-to-path`, and `node_modules/prebuild-install` are gone from both disk and `package-lock.json`. `node_modules/node-addon-api` is present and that is fine; it is build-time headers and nothing in `lib/` requires it at runtime, and it is deliberately not added to `electron-builder.yml`.
6. Run `npm run electron:check-server-deps`. It must print `✓ better-sqlite3: 13.0.x satisfies server range ^13.0.3` (with `../quilltap-server` present, as it is on the user's machine).

## WP2 — Replace the rebuild script with a select script

**Files:** `scripts/rebuild-native-modules.ts` (renamed via `git mv` to `scripts/select-native-modules.ts`), the five `scripts` entries in `package.json` that name it. Because WP1 also edits `package.json`, WP2 must start from WP1's committed result and change only the `scripts` block; or, if the orchestrator prefers, fold the `scripts` edits into WP1 and have WP2 touch only the script file. Either is acceptable; pick one and say so in the agent brief.

Rename the npm script `electron:rebuild-native` to `electron:select-native` and update all five `electron:build:*` entries that chain it. Keep the chain order: `check-server-deps` → `compile` → `select-native` → `electron-builder`.

Rewrite the script's header comment to describe what it now does. The old "ORDER MATTERS" prologue about a plain-Node prebuild clobbering a compiled binary is no longer true and must be removed, not softened. Keep one sentence noting that Step 1's `npm install --no-save` re-extracts any package it re-resolves, so the prune in Step 2 must come after it (otherwise the prune is undone, which is harmless but pointless).

Keep unchanged:

- The `childEnv` filtering of `npm_config_allow_scripts` and the reason comment (4.2.1 lesson).
- The electron-version read at the top (still printed, still useful in logs).
- **Step 1** (sharp and `@napi-rs/canvas` platform packages) in full. Renumber its banner to `Step 1/3`.

**Step 2 — Prune the driver to this platform.** Replaces the `node-gyp` compile.

```ts
// npm alias: package.json declares "better-sqlite3": "npm:better-sqlite3-multiple-ciphers@…"
// so the directory is node_modules/better-sqlite3 despite the package name.
const bsqlPath = join(PROJECT_ROOT, 'node_modules', 'better-sqlite3');
// fail if absent, as today

const manifest = JSON.parse(readFileSync(join(bsqlPath, 'package.json'), 'utf-8'));
// fail if manifest.name !== 'better-sqlite3-multiple-ciphers'

const prebuildsDir = join(bsqlPath, 'prebuilds');
const keep = `${process.platform}-${process.arch}.node`;
// fail if !existsSync(join(prebuildsDir, keep)) — message must name the file and the
// directory listing, because a missing prebuild means an unsupported platform, not a bug here.

for (const entry of readdirSync(prebuildsDir)) {
  if (entry !== keep) rmSync(join(prebuildsDir, entry), { force: true });
}
// Compile-time-only payload: ~13 MB of sqlite3.c plus the C++ sources and gyp file.
// `build/` is a leftover from a v12-era checkout and would otherwise ship a stale binary.
for (const rel of ['deps', 'src', 'binding.gyp', 'build']) {
  rmSync(join(bsqlPath, rel), { recursive: true, force: true });
}
```

Log what was kept and what was removed. The shell targets glibc Linux only (AppImage and deb built on `ubuntu-latest`), so `linuxmusl-*` is always pruned on Linux; say so in a comment. Do not special-case the musl choice; `process.platform` is `linux` on both and the loader's own glibc test picks `linux-<arch>` at runtime on the hosts the shell supports.

**Step 3 — Probe the driver under Electron.** Keep the existing `spawnSync(electronBin, …)` shape with `ELECTRON_RUN_AS_NODE: '1'`, but change what it loads and what it asserts:

- Load the **package directory**, not a `.node` file: pass `bsqlPath` in the env var and `require()` it. Requiring an absolute directory path resolves through `main` (`lib/index.js`) and therefore through `lib/binding.js`'s platform detection. That detection is now the only thing left that can go wrong, so it is what the probe must exercise. Do not require `lib/binding.js` by subpath; the `exports` map forbids it.
- Inside the probe: `new Database(':memory:')`, then `db.pragma('cipher', { simple: true })` and `db.prepare('select sqlite_version() as v').get().v`. Print one line such as `driver ok cipher=chacha20 sqlite=3.53.4 abi=145`.
- Fail the script if the probe exits non-zero, if the line is missing, or if `cipher` is not `chacha20`. The cipher check is what proves the multiple-ciphers build loaded and not some plain `better-sqlite3` that wandered in. Print the SQLite version but do not assert a specific number in code; it moves with every driver bump and WP7 checks it by eye this time.
- The failure text should no longer talk about a later `npm install` reinstalling a plain-Node prebuild. Say instead that the prebuild for this platform did not load under Electron's Node, and echo the loader's first five lines of stderr as today.

Rename the probe's env var from `QT_ABI_PROBE` to something that reflects a directory, such as `QT_DRIVER_DIR`.

The final banner should read along the lines of `Done! Native modules are selected and ready for electron-builder.`

Type safety: the script is run by `tsx` and is outside `electron/tsconfig.json`, so `npm run typecheck` does not cover it. Run it for real as the check: `npm run electron:select-native` must succeed end to end on the user's macOS arm64 machine. This is also WP7 acceptance item 1 and 2.

## WP3 — electron-builder configuration

**Files:** `electron-builder.yml` only.

1. In `files`, remove `node_modules/bindings/**/*` and `node_modules/file-uri-to-path/**/*`. Keep `node_modules/better-sqlite3/**/*`.
2. Replace the two comments that say native modules are "rebuilt against Electron's ABI" / "rebuilt in build scripts against Electron's Node ABI" with wording that says they are prebuilt N-API binaries selected for the target platform by `scripts/select-native-modules.ts`. Keep the sentence explaining why `npmRebuild: false` is set (the `.bin` symlink codesign problem); that reason is still valid and is independent of the driver.
3. Do **not** add `asarUnpack` pre-emptively. WP7 item 3 verifies that `app.asar.unpacked/node_modules/better-sqlite3/prebuilds/` holds exactly the target binary. Only if that check fails, add:

   ```yaml
   asarUnpack:
     - node_modules/better-sqlite3/**/*
   ```

   and record in the CHANGELOG why it was needed. (It is not expected to be: see Verified state.)

## WP4 — Runtime injection check

**Files:** `electron/standalone-download-manager.ts` only.

1. In the `linkNativeModules()` docblock, replace "rebuilt at build time against Electron's Node ABI by rebuild-native-modules.ts" with a sentence saying the Electron app bundles the platform's prebuilt N-API binaries, selected at build time by `scripts/select-native-modules.ts`, in `app.asar.unpacked/`.
2. `copyModule('better-sqlite3', betterSqlite3Dir, true)` and the `resolveModuleDir()` preference for the unpacked path stay exactly as they are. The copy shrinks from roughly 34 MB to roughly 3 MB plus `lib/` because WP2 pruned the source; no code is needed for that.
3. After the existing two `warnIfNativeBinaryMissing()` calls, add a presence check for the driver binary in the cache: `path.join(standaloneNodeModules, 'better-sqlite3', 'prebuilds', `${process.platform}-${process.arch}.node`)`. If it is absent, `console.warn` a line in the same style as the other two, naming the expected path. Implement it as a small private method alongside `warnIfNativeBinaryMissing()` rather than bending that scope/prefix method to fit an unscoped package. This is the 4.1.14 lesson applied to the driver: the alignment guard proves the version matches, not that the binary arrived.
4. `npm run typecheck` must pass.

## WP5 — Release workflow

**Files:** `.github/workflows/release.yml` only.

1. Rename the three steps `Rebuild native modules for Electron` to `Select native modules for Electron` and change their `run` to `npx tsx scripts/select-native-modules.ts`.
2. Update the banner comment above the build jobs: it currently says "rebuild native modules for each platform's Electron ABI". Say instead that the step selects the platform's prebuilt native modules and probes the SQLite driver under Electron.
3. Nothing else changes. No step in any job needed a C++ toolchain except the driver compile, and sharp and canvas were already prebuilt. Keep the probe step on all three platforms; the Linux run is what proves `process.report.getReport()` works under Electron's Node on the glibc runner.

## WP6 — Documentation and changelog

**Files:** `README.md`, `CHANGELOG.md`. (Not `package.json`; WP1 bumped the version. Not `CLAUDE.md`; it is already accurate.)

README changes, all in the "Building from Source" and "Architecture" sections:

- Line 88: the `electron:rebuild-native` line in the code block becomes `npm run electron:select-native   # installs the platform's prebuilt native modules (sharp, canvas, SQLite driver)`. Note the README currently tells developers to run this before `electron:dev`; with v13 that is no longer necessary for the driver, and it never was for sharp or canvas in dev mode. Either drop the line from the quick-start block and mention the script under "Packaging" only, or keep it with the honest comment. Prefer dropping it; `electron:dev` runs against the repo's `node_modules` as installed.
- Line 100: "All build scripts run `electron:rebuild-native` before packaging" becomes the new script name.
- Line 118: "rebuilds native modules (`better-sqlite3`, `sharp`) against Electron's Node ABI" becomes "installs the platform's prebuilt native modules (`better-sqlite3`, `sharp`, `@napi-rs/canvas`)".
- Line 132 (the closing italic paragraph): "the native module rebuilds" becomes "the native module wrangling" or similar. Keep the voice of that paragraph.

CHANGELOG: add a `## 4.2.5` section at the top with a `### Changes` entry in the house voice (steampunk, roaring 20s, Gatsby, Wodehouse, Lemony Snicket). The entry must convey these facts, in whatever order the prose wants them:

- The SQLite driver (`better-sqlite3-multiple-ciphers`) moves from 12.11.1 to 13.0.3, which brings SQLite 3.53.4 and SQLite3MultipleCiphers 2.4.0.
- v13 is a Node-API addon with the binary for every platform already in the box, so the shell no longer compiles it against Electron's headers at build time. The `node-gyp` step, the Electron headers download, and the ordering hazard that produced the 4.1.5 through 4.1.11 wrong-ABI releases are all gone, not merely guarded.
- The script formerly called `rebuild-native-modules.ts` is now `select-native-modules.ts`; it keeps the one prebuild the platform needs and discards the other seven along with the C sources, shrinking what the shell carries and copies into the server cache on every boot from roughly 34 MB to roughly 3 MB.
- A probe still loads the driver under Electron at build time, now exercising the loader's platform detection and reporting the cipher and SQLite version.
- The shell now warns in the log if the driver binary is not physically present in the server cache after injection, as it already does for sharp and canvas.
- No compatibility gate: a 4.2.4 shell under a 4.12 server and a 4.2.5 shell under an older server are both supported configurations, and databases written by either driver open in the other.
- Linux: the v13 prebuild requires glibc 2.35 or newer (Ubuntu 22.04, Debian 12). This is not a new floor; the previous binary was compiled on Ubuntu 24.04 and already required newer than that.
- Housekeeping: `@electron/rebuild` leaves devDependencies (unused), `bindings` and `file-uri-to-path` leave the packaged files (no longer dependencies), and the `allowScripts` entry for the driver becomes an explicit deny (npm infers an install script from `binding.gyp`; see WP1 step 2).
- Future Electron bumps no longer wait on the driver fork tracking V8 internals; Electron's N-API version is the only remaining contract.

Use the facts above verbatim where numbers are concerned. Do not invent a version number for anything.

## WP7 — Acceptance

Run by the orchestrator after WP2 through WP6 are merged into one tree. Items 2 (win, linux) cannot be run locally; everything else can.

1. **Clean install, no compiler.** `rm -rf node_modules && npm ci` produces no `node-gyp`/`make`/`CXX` output. `node_modules/better-sqlite3/prebuilds/` holds eight files.
2. **Select and probe.** `npm run electron:select-native` succeeds. Afterwards `prebuilds/` holds exactly `darwin-arm64.node`; `deps/`, `src/`, `binding.gyp`, and `build/` are gone; the probe line reports `cipher=chacha20` and `sqlite=3.53.4`. On Windows and Linux this is verified by the next tag build's CI logs; record it as unverified-locally in the final report, not as done.
3. **Packaging.** `npm run electron:build:mac:dev` passes `check-server-alignment` (server repo on `^13.0.3`), compiles, selects, and packages. Then:

   ```bash
   unzip -l out/Quilltap-4.2.5-arm64.zip | ggrep "app.asar.unpacked/node_modules/better-sqlite3/prebuilds/"
   ```

   must list exactly one `.node` file, `darwin-arm64.node`, and no `build/Release/better_sqlite3.node` anywhere in the archive.
4. **Fresh cache, embedded boot.** `npm run clean:server-cache`, then launch the packaged app (or `npm run electron:dev`) in Direct mode against a scratch instance directory. The server reaches healthy. In that instance's `logs/embedded-server.log`, the line `SQLCipher driver loaded` reports `driverVersion: 13.0.3` and `sqliteVersion: 3.53.4`. In the standalone cache (`~/Library/Caches/Quilltap/standalone/node_modules/better-sqlite3/prebuilds/`) there is one file. The shell's own log shows no `No native … binary present after injection` warning for the driver.
5. **Interoperability through the shell's own path.** The same build, Direct mode, against an instance that was last opened by shell 4.2.4 (driver v12). It opens without complaint and the boot line reads `13.0.3`. If no such instance exists, create one by running 4.2.4 against a scratch directory first; the installer for 4.2.4 is in `out/` or on GitHub Releases.
6. **Type-check.** `npm run typecheck` passes.
7. **No stragglers.** `ggrep -rn "rebuild-native\|rebuild native\|Node ABI\|node-gyp" --include=*.ts --include=*.yml --include=*.md --include=*.json . | ggrep -v node_modules | ggrep -v "^./out/" | ggrep -v CHANGELOG.md` returns only the two notes/spec documents under `docs/`. (CHANGELOG history is excluded because older entries legitimately describe the old world.)

## Things that are easy to get wrong

- **Order of Step 1 and Step 2 in the script.** The `npm install --no-save` in Step 1 can re-extract `better-sqlite3` if npm decides the tree needs re-resolving. If the prune ran before it, the eight prebuilds would be back and the shipped app would be 30 MB heavier than intended. Prune after install.
- **Requiring the driver in the probe.** Use the absolute package directory. `require('better-sqlite3/lib/binding.js')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. `require('<dir>/prebuilds/darwin-arm64.node')` would load the binary but skip the platform detection, which is the part worth testing.
- **Windows `process.arch`.** The shell builds `x64` on Windows; the prebuild is `win32-x64.node`. `process.arch` on the runner is what the loader will consult at runtime, so the prune key and the loader's key agree by construction.
- **The glibc floor is not a regression.** Do not phrase the Linux note in the CHANGELOG as a new requirement.
- **`electron-builder.yml` `files` still needs `node_modules/better-sqlite3/**/*`.** Removing the two transitive-dependency lines is correct; removing the driver line would ship nothing to inject.
- **Dev mode.** `electron:dev` runs against the repo's `node_modules`, which after `npm install` holds all eight prebuilds. That works; the loader picks the right one. After a local build it holds one; that also works. Neither needs a pre-step.

## Follow-ups this spec deliberately leaves alone

- Reassess the Electron 42 cap (`^41.10.7` in `package.json`, chronicled in the 4.1.5 changelog). The reason for it was the v12 fork's V8 coupling; v13 removes that reason, but an Electron bump deserves its own change and its own test pass.
- The alignment guard in CI. It would be a small addition (a shallow clone of the server repo on the mac job, or a pinned manifest fetch), but it is a process decision for the user, not a side effect of this spec.
