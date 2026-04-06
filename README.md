# The Quilltap Launcher

*The front door, the foyer, and the fellow who takes your coat.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Latest Stable](https://img.shields.io/github/v/release/foundry-9/quilltap-shell?logo=github&label=stable&sort=semver&filter=!*dev*)](https://github.com/foundry-9/quilltap-shell/releases/latest)
[![Docker Hub](https://img.shields.io/docker/v/foundry9/quilltap?logo=docker&label=docker&sort=semver)](https://hub.docker.com/r/foundry9/quilltap)
[![npm](https://img.shields.io/npm/v/quilltap?logo=npm)](https://www.npmjs.com/package/quilltap)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/channels/1476289075152556205/1476290238187049184)

<p align="center">
  <img src="https://quilltap.ai/images/welcome-to-quilltap-2-8.png" alt="Welcome to Quilltap" />
</p>

**Website:** [quilltap.ai](https://quilltap.ai) · **Discord:** [Join us](https://discord.com/channels/1476289075152556205/1476290238187049184) · **Docker:** [foundry9/quilltap](https://hub.docker.com/r/foundry9/quilltap)

---

There is a school of thought — held chiefly by people who have never had to explain Docker to their mother — that the best software requires no installation at all. We cannot offer you that. What we can offer is the next best thing: a single application that handles the machinery so you don't have to think about it.

The Quilltap Launcher is an Electron desktop application that manages the entire lifecycle of your Quilltap server. It downloads the server, starts it, keeps it updated, and presents the interface in a native window on macOS, Windows, and Linux. It is the recommended way for most people to run Quilltap, and it is the only path that does not require you to open a terminal.

If you have ever used a desktop email client — the kind that talks to a mail server without asking you to configure SMTP ports — the concept is the same. The Launcher is the client. Quilltap is the server. The Launcher runs the server for you, in one of three ways, and you never need to know which one unless you want to.

## The Three Runtimes

The splash screen presents three buttons. They are not decorative.

### Direct

The Launcher runs the Quilltap server using its own bundled Node.js 22 runtime. No virtual machine, no container, no external dependencies. This is the fastest path from launch to conversation, and it is the recommended default for anyone who is here for roleplay, companionship, creative writing, or conversation — which is to say, most people.

The trade-off is isolation: the server runs with your user permissions, on your machine, with access to your filesystem. For a pleasant chat with a fictional character, this is academic. For agentic AI with shell access and code execution, it is emphatically not. If you intend to let your characters run scripts, read on.

### Docker

The Launcher pulls and manages a Docker container from `foundry9/quilltap`. The server runs inside the container with its own filesystem and process space. This provides a meaningful isolation boundary — not as airtight as a virtual machine, but considerably better than nothing, and with near-instant startup after the initial image pull.

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows, macOS) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux). The Launcher detects Docker availability automatically and disables the button if it isn't found.

### VM (macOS and Windows only)

The Launcher boots a lightweight Linux virtual machine — [Lima](https://lima-vm.io/) with Apple's Virtualization.framework on macOS, WSL2 on Windows — and runs the Quilltap server inside it. This is genuine locked-room isolation: if an AI-generated script misbehaves, it misbehaves inside a contained environment with no access to your host system beyond what you've explicitly shared.

The first launch is the slowest of the three options (it downloads a ~150 MB system image and boots a Linux guest), but subsequent launches take only a few seconds. Lima binaries are bundled with the macOS build; WSL2 is built into Windows 10 and 11.

On Linux, the VM button is hidden. Linux *is* the VM.

## The Splash Screen

When you launch the application, you'll see a splash screen with the Quilltap quill logo, three runtime buttons, a data directory list, and a server version selector. This is where all the decisions happen — and most of them have sensible defaults, so the typical first launch looks like this:

1. Choose **Direct** (or leave it selected — it's the default on fresh installs)
2. Click **Start**
3. Wait a moment while the server downloads and starts
4. The application opens in a native window

That's it. No configuration files, no environment variables, no incantations.

### Data Directories

Quilltap stores everything — your chats, characters, memories, API keys, themes, and database — in a single data directory. The Launcher lets you manage multiple data directories from the splash screen: one for work, one for fiction, one for experiments. Each gets its own database, its own configuration, its own VM (if applicable).

You can add directories, rename them (the display name, not the path), and remove them. Removal offers two options: delete the configuration reference only (the data stays on disk), or delete the configuration *and* the data (irreversible, and the dialog will tell you so in red). In VM mode, a separate "Erase VM" button lets you destroy and recreate the virtual machine for a directory without touching your data.

The **Auto-start with last used directory** checkbox does what it says. If checked, subsequent launches skip the splash screen entirely and go straight to startup with whichever directory you used last.

### Server Versions

The version selector lets you choose which Quilltap server version to run. Options include "Latest Release" (the newest stable tag), "Latest Dev" (the newest tag of any kind, including prereleases), and every specific version available on GitHub Releases. The Launcher fetches the version list from the GitHub API and filters it by the assets available for your chosen runtime mode.

When a newer server version is available than the one you've pinned, an upgrade banner appears on the splash screen. Stable users are only offered newer stable releases; dev users see the newest version across both channels. Declining suppresses the prompt for that specific version, but a newer release will prompt again.

## Auto-Update

After the main window loads, the Launcher checks GitHub Releases for newer versions of *itself* — the Electron shell, not the server. When an update is available, a native dialog offers to download and install it. The download shows a progress indicator, and the update installs with a restart. Declined versions are remembered so you aren't asked again until something newer arrives.

If the automatic check misses (because you were offline at launch, or the network hiccuped), the **Help → Check for Updates...** menu item lets you trigger a manual check at any time. It always shows feedback: the update prompt, a "you're up to date" confirmation, or an error message. It also bypasses the "declined version" memory, so you can change your mind about an update you previously skipped.

The auto-update check retries every four hours, so a machine that was offline at startup will still catch available updates within the same session.

## Building from Source

The Launcher is a standard Electron application. Clone the repository, install dependencies, and build:

```bash
git clone https://github.com/foundry-9/quilltap-shell.git
cd quilltap-shell
npm install
npm run electron:rebuild-native   # rebuilds better-sqlite3 and sharp against Electron's Node ABI
npm run electron:dev               # development mode with hot reload
```

### Packaging

```bash
npm run electron:build:mac         # macOS DMG + zip (code signing + notarization if configured)
npm run electron:build:win         # Windows NSIS installer
npm run electron:build:linux       # Linux AppImage + deb
```

All build scripts run `electron:rebuild-native` before packaging. The macOS build stages Lima binaries from GitHub Releases into the app bundle via `electron:stage-lima`.

### Release Pipeline

The GitHub Actions workflow (`.github/workflows/release.yml`) triggers on semver tag pushes. It builds and signs the Launcher for all three platforms — macOS with code signing and Apple notarization, Windows with Azure Trusted Signing, Linux with standard packaging — and creates a GitHub Release with installers and auto-update metadata files (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`).

To cut a release:

```bash
./scripts/tag-release.sh
```

The script reads the version from `package.json`, creates an annotated git tag, and pushes it to origin. It checks for existing tags and dirty working trees before proceeding.

## Architecture

The Launcher passes two environment variables to the server in all launch modes: `QUILLTAP_SHELL` (the Launcher version string) and `QUILLTAP_SHELL_CAPABILITIES` (a comma-delimited set of capability flags, currently empty, awaiting future flags like `OPENS_FS_PATH` and `DOWNLOADS_FILE`).

In Direct mode, the Launcher downloads standalone server tarballs from GitHub Releases, unpacks them into a local cache, rebuilds native modules (`better-sqlite3`, `sharp`) against Electron's Node ABI, and spawns the Next.js standalone server as a child process. Server stdout/stderr is written to `embedded-server.log` in the data directory's logs folder.

Health checking polls the server's health endpoint with an abort callback for fatal errors — version guard blocks, migration failures, module-not-found — so the startup sequence fails fast instead of polling for two minutes against an unrecoverable state.

In Docker and VM modes, the Launcher manages container/VM lifecycle through the respective platform tools, passing the selected server version tag and data directory mount. The shell bridge API (`window.quilltap`) exposes IPC methods for the splash screen renderer: directory management, runtime mode selection, version selection, retry, quit, and — as of 4.0.8 — copying generated images to the system clipboard.

## What This Is Not

The Launcher is not the Quilltap server. It does not contain the chat interface, the character system, the Commonplace Book, the Concierge, or any of the subsystems that make Quilltap what it is. It is the parlor that opens onto the rest of the house — the coat check, the threshold, the mechanism by which the door opens and the lights come on.

The server lives at [foundry-9/quilltap-server](https://github.com/foundry-9/quilltap-server). The documentation lives at [quilltap.ai](https://quilltap.ai). If you have arrived here, you are in the right place to get started. If you have questions about what happens after the door opens, those are the places to look.

---

*The Launcher exists because the distance between "I want to try this" and "I am using this" should be measured in clicks, not in terminal commands. It is a single download, a single install, and a single button. The machinery behind it — the VMs, the containers, the health checks, the version management, the native module rebuilds — is considerable, and it is all there so that you do not have to be. Come in. The Estate is waiting.*
