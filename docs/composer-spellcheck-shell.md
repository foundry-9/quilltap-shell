# Composer Spellcheck — Shell-side Spec (Layer 1)

**Status:** Proposal / Not Implemented
**Repo:** quilltap-shell only
**Counterpart:** A companion spec in `quilltap-server` (`docs/developer/features/composer-spellcheck.md`) covers the renderer-side work. That work can land in either order; this spec is self-contained.

## Summary

The Quilltap server's renderer (running inside this shell) will gain a browser-native spellcheck feature for the Salon ChatComposer and Document Mode rich editor. Browser spellcheck on its own works without any shell changes (it's a contentEditable attribute), but three things only the Electron host can provide:

1. A **right-click suggestion menu** ("Did you mean…", "Add to dictionary"), wired via `webContents.on('context-menu', ...)`.
2. A **custom dictionary feed** so invented names (characters, places, conlang nouns) don't appear misspelled — fed by the renderer via a new preload bridge.
3. A **language list configuration** for multilingual writers.

This spec covers all three.

## Verified state (2026-05-22)

- **Electron version**: `^41.7.0` in `package.json`. All required APIs are present: `session.setSpellCheckerLanguages`, `session.addWordToSpellCheckerDictionary`, `session.removeWordFromSpellCheckerDictionary`, `session.listWordsInSpellCheckerDictionary`, `session.availableSpellCheckerLanguages`, `session.isSpellCheckerEnabled`, `session.setSpellCheckerEnabled`, and `webContents.on('context-menu', params)` with `params.misspelledWord`, `params.dictionarySuggestions`, `params.isEditable`, `params.editFlags`, `params.selectionText`.
- **webPreferences**: no `spellcheck: false` anywhere. The main content `BrowserWindow` (`electron/main.ts:793`) sets only `preload`, `contextIsolation`, `nodeIntegration`. Chromium's default `spellcheck: true` applies. No change needed here.
- **Context-menu handler**: none exists. Right-clicking a misspelled word currently does nothing useful. Clean slate.
- **Preload bridge**: already exposes a `window.quilltap` object via `contextBridge.exposeInMainWorld` in `electron/preload.ts`. This spec extends that object; do **not** create a parallel one.
- **`SHELL_CAPABILITIES`** in `electron/constants.ts` is currently the empty string. This spec adds one flag.

## What the renderer will call

The renderer-side spec adds the calls listed below. You can build and test the shell side independently — exercise the bridge from the Electron DevTools console.

```ts
window.quilltap.setDictionaryWords(words: string[]): Promise<void>
window.quilltap.setSpellCheckerLanguages(codes: string[]): Promise<void>
window.quilltap.getSpellCheckerStatus(): Promise<{
  enabled: boolean;
  languages: string[];
  availableLanguages: string[];
}>
```

The renderer detects shell presence by checking `typeof window.quilltap?.setDictionaryWords === 'function'`. If your build of the bridge doesn't include those methods, the renderer cleanly falls back to plain browser spellcheck with no dictionary feed. No coordinated release is required.

## Architecture

### Capability flag

`SHELL_CAPABILITIES` in `electron/constants.ts` is the canonical list of comma-delimited flags advertised to the server via `QUILLTAP_SHELL_CAPABILITIES`. Per CLAUDE.md, that env var must flow through every launch mode (embedded, Docker `-e`, Lima template, WSL2 inherited env). Adding the flag here causes that flow automatically; no per-mode plumbing change is needed.

Change:

```ts
// electron/constants.ts
export const SHELL_CAPABILITIES = 'SPELLCHECK_DICTIONARY';
```

### Dictionary lifecycle (Quilltap-managed set)

Chromium persists `addWordToSpellCheckerDictionary` additions across sessions in the user profile, and there is no namespacing API. If we naively add character names every time the renderer pushes its current list, the user's personal dictionary accretes every name they've ever invented forever — including renamed and deleted characters.

The shell tracks the words it has added on Quilltap's behalf in a small JSON file and applies diffs:

- Path: `path.join(app.getPath('userData'), 'quilltap-managed-dict.json')`
- Shape: `{ words: string[] }`
- On each `setDictionaryWords(newWords)` call:
  - Load tracked set (empty array if file missing).
  - `toAdd = newWords \ tracked`; for each, `addWordToSpellCheckerDictionary`.
  - `toRemove = tracked \ newWords`; for each, `removeWordFromSpellCheckerDictionary`.
  - Write `{ words: newWords }` to disk.
- On shell startup: **do not clear the dictionary.** Let the renderer push the current set once it loads. If the renderer never pushes (server failed to start, etc.), stale words remain temporarily benign — they just look like real words.
- File writes use `fs.promises.writeFile` with atomic-rename if any other state files in the shell already follow that pattern; otherwise a plain write is acceptable for v1 since the file is small and infrequently written.

### Language list

`session.setSpellCheckerLanguages(codes)` accepts an array of locale codes. Invalid codes throw. The manager should validate against `session.availableSpellCheckerLanguages` before calling, logging warnings for any unsupported codes and silently dropping them rather than throwing across IPC.

There's no UI for language selection in v1. The renderer may call `setSpellCheckerLanguages` from a future settings page, but the shell-side API needs to be in place now.

### Context-menu handler

The handler runs on **every** right-click, since registering one replaces Chromium's default for the affected `webContents`. Two options:

**A. Always handle.** Provide cut/copy/paste/select-all for editable surfaces, copy for selections, and spell suggestions when present. Simpler, more consistent, gives Quilltap a stable context menu across platforms.

**B. Gate on editable or misspelling.** `if (!params.isEditable && !params.misspelledWord) return;` — fall back to Chromium's default for non-editable, non-misspelled contexts.

**Recommendation: A.** Chromium's default Electron context menu is minimal (Inspect Element in dev builds, basically nothing in production). Replacing it consistently is the lower-surprise choice. If the developer prefers B, it's a one-line change.

## Implementation

### File 1 — `electron/constants.ts`

Change:

```diff
- export const SHELL_CAPABILITIES = '';
+ export const SHELL_CAPABILITIES = 'SPELLCHECK_DICTIONARY';
```

### File 2 — `electron/spellcheck-manager.ts` (new)

```ts
import { app, Session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const DICT_FILE = path.join(app.getPath('userData'), 'quilltap-managed-dict.json');

interface ManagedDict {
  words: string[];
}

function loadTracked(): Set<string> {
  try {
    const raw = fs.readFileSync(DICT_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as ManagedDict;
    if (!Array.isArray(parsed.words)) return new Set();
    return new Set(parsed.words);
  } catch {
    return new Set();
  }
}

function saveTracked(words: Set<string>): void {
  const payload: ManagedDict = { words: Array.from(words) };
  try {
    fs.writeFileSync(DICT_FILE, JSON.stringify(payload), 'utf-8');
  } catch (err) {
    console.warn('[Spellcheck] Failed to persist managed dictionary:', err);
  }
}

/**
 * Replace the Quilltap-managed dictionary set with `newWords`. Adds and
 * removes against Chromium's dictionary to match, leaving any user-added
 * words (added via context menu) untouched as long as they don't appear
 * in the managed set.
 */
export function applyDictionaryWords(session: Session, newWords: string[]): void {
  const newSet = new Set(newWords);
  const tracked = loadTracked();

  let added = 0;
  let removed = 0;

  for (const word of newSet) {
    if (!tracked.has(word)) {
      session.addWordToSpellCheckerDictionary(word);
      added++;
    }
  }
  for (const word of tracked) {
    if (!newSet.has(word)) {
      session.removeWordFromSpellCheckerDictionary(word);
      removed++;
    }
  }

  saveTracked(newSet);
  console.log(`[Spellcheck] Applied dictionary delta: +${added}, -${removed} (total managed: ${newSet.size})`);
}

/**
 * Set the spellchecker language list. Invalid codes are dropped with a
 * warning rather than thrown across IPC.
 */
export function setLanguages(session: Session, codes: string[]): void {
  const available = new Set(session.availableSpellCheckerLanguages);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const code of codes) {
    if (available.has(code)) valid.push(code);
    else invalid.push(code);
  }
  if (invalid.length > 0) {
    console.warn(`[Spellcheck] Dropping unsupported language codes: ${invalid.join(', ')}`);
  }
  if (valid.length > 0) {
    session.setSpellCheckerLanguages(valid);
    console.log(`[Spellcheck] Set languages: ${valid.join(', ')}`);
  } else {
    console.warn('[Spellcheck] No valid languages provided; leaving current list unchanged');
  }
}

export function getStatus(session: Session): {
  enabled: boolean;
  languages: string[];
  availableLanguages: string[];
} {
  return {
    enabled: session.isSpellCheckerEnabled(),
    languages: session.getSpellCheckerLanguages(),
    availableLanguages: session.availableSpellCheckerLanguages,
  };
}
```

### File 3 — `electron/main.ts` (extend the main `BrowserWindow` setup)

Locate the main content window creation around line 793 (`webPreferences` block). After `const win = new BrowserWindow(winOptions);` and before the existing `resize`/`move` listeners, add:

```ts
import * as spellcheck from './spellcheck-manager';
import { Menu, ipcMain } from 'electron';

// ... inside the function, after `const win = new BrowserWindow(winOptions);`:

// Spellcheck IPC handlers (per-window — registered once when the main window is created)
ipcMain.handle('spellcheck:set-dictionary-words', (_event, words: string[]) => {
  if (!Array.isArray(words)) throw new Error('words must be an array of strings');
  spellcheck.applyDictionaryWords(win.webContents.session, words);
});

ipcMain.handle('spellcheck:set-languages', (_event, codes: string[]) => {
  if (!Array.isArray(codes)) throw new Error('codes must be an array of strings');
  spellcheck.setLanguages(win.webContents.session, codes);
});

ipcMain.handle('spellcheck:get-status', () => spellcheck.getStatus(win.webContents.session));

// Context menu — handles spelling suggestions and standard edit actions
win.webContents.on('context-menu', (_event, params) => {
  const template: Electron.MenuItemConstructorOptions[] = [];

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    if (suggestions.length === 0) {
      template.push({ label: 'No suggestions', enabled: false });
    } else {
      for (const suggestion of suggestions) {
        template.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
    }
    template.push({ type: 'separator' });
    template.push({
      label: `Add "${params.misspelledWord}" to dictionary`,
      click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
    });
    template.push({ type: 'separator' });
  }

  if (params.isEditable) {
    template.push({ role: 'cut', enabled: params.editFlags.canCut });
    template.push({ role: 'copy', enabled: params.editFlags.canCopy });
    template.push({ role: 'paste', enabled: params.editFlags.canPaste });
    template.push({ type: 'separator' });
    template.push({ role: 'selectAll' });
  } else if (params.selectionText) {
    template.push({ role: 'copy' });
  }

  if (template.length === 0) return;
  Menu.buildFromTemplate(template).popup({ window: win });
});
```

**Important — IPC handler registration is global.** `ipcMain.handle` registers a handler keyed by channel name across the whole `ipcMain` singleton, not per-window. If the main window can be created more than once during the app's lifetime (e.g. after a backend restart via `restartServer()`), each re-creation will attempt to re-register the same handler and Electron will throw `Attempted to register a second handler for ...`.

Two acceptable mitigations — pick whichever fits the rest of the codebase:

1. **Register at app `ready` instead of per-window**, keep a module-level `currentMainWindow` reference that the IPC handlers consult. (Cleaner.)
2. **Call `ipcMain.removeHandler(channel)` before each `handle` registration.** (More local, less invasive.)

Recommend (1) if `main.ts` already has an `app.whenReady()` block with similar one-time wiring. The context-menu listener is fine to register per-window since it's attached to the window's `webContents`, not the global `ipcMain`.

### File 4 — `electron/preload.ts` (extend)

Extend the existing `contextBridge.exposeInMainWorld('quilltap', { ... })` object. Add a new section at the bottom:

```ts
  // --- Spellcheck ---
  /** Replace the Quilltap-managed dictionary with the given words (diff applied internally) */
  setDictionaryWords: (words: string[]): Promise<void> =>
    ipcRenderer.invoke('spellcheck:set-dictionary-words', words),
  /** Set the spellchecker language list (invalid codes are silently dropped with a warning) */
  setSpellCheckerLanguages: (codes: string[]): Promise<void> =>
    ipcRenderer.invoke('spellcheck:set-languages', codes),
  /** Inspect the current spellchecker state */
  getSpellCheckerStatus: (): Promise<{ enabled: boolean; languages: string[]; availableLanguages: string[] }> =>
    ipcRenderer.invoke('spellcheck:get-status'),
```

### File 5 — `package.json`

Bump the patch version. Do **not** publish yet; pause and ask the developer to confirm before tagging.

### File 6 — `CHANGELOG.md`

Add a terse top entry in straightforward American English (the shell repo's CHANGELOG follows the same dev-facing convention as the server's). Example:

```
- Add spellchecker IPC bridge (`setDictionaryWords`, `setSpellCheckerLanguages`, `getSpellCheckerStatus`) and a right-click context menu with spelling suggestions and "Add to dictionary" for the main window. Advertise `SPELLCHECK_DICTIONARY` capability flag to the server.
```

## Verification

### Type check

```
npx tsc -p electron/tsconfig.json
```

(Per CLAUDE.md, not `npm run build`.)

### Manual verification — independent of server changes

You can test the entire shell-side surface against any current Quilltap server by exercising the bridge from DevTools. Open the main window, open DevTools, and in the console:

```js
// 1. Inspect status
await window.quilltap.getSpellCheckerStatus()
// → { enabled: true, languages: ['en-US'], availableLanguages: [...] }

// 2. Add some words
await window.quilltap.setDictionaryWords(['Aristarchus', 'Aristanthus', 'Quilltap'])
// Right-click a text field and confirm those don't get squiggles.

// 3. Diff a removal
await window.quilltap.setDictionaryWords(['Aristarchus', 'Quilltap'])
// "Aristanthus" should squiggle again. Check the shell stderr for:
//   [Spellcheck] Applied dictionary delta: +0, -1 (total managed: 2)

// 4. Persistence
// Restart the app, then in DevTools:
await window.quilltap.getSpellCheckerStatus()
// (Implicitly verifies the tracked file survived restart — managed words
// are still in the dictionary because they weren't re-added or removed.)

// 5. Languages
await window.quilltap.setSpellCheckerLanguages(['en-US', 'fr'])
// Type a French word with an English-only typo; both dictionaries consulted.

// 6. Invalid language is dropped, not thrown
await window.quilltap.setSpellCheckerLanguages(['en-US', 'kl-XX'])
// Shell stderr:
//   [Spellcheck] Dropping unsupported language codes: kl-XX
//   [Spellcheck] Set languages: en-US
```

### Manual verification — context menu

In any editable contentEditable or textarea:

- Type "teh quik" → right-click "teh" → suggestions appear → clicking "the" replaces it.
- Right-click an invented name → "Add to dictionary" → squiggle disappears immediately and persists across reload.
- Right-click in a non-editable area with text selected → "Copy" only.
- Right-click in a non-editable area with no selection → no menu (or default Chromium menu, depending on which gating option you picked).

### Tracked file location

After verification, confirm `<userData>/quilltap-managed-dict.json` exists and contains the expected `{ "words": [...] }` shape. On macOS that's `~/Library/Application Support/<app name>/quilltap-managed-dict.json` — note this is the shell's own userData, not a Quilltap *instance* data directory.

## Open questions

- **Should the context-menu handler also include "Inspect Element" in dev builds?** Existing Electron conventions usually do. Worth mentioning to keep parity with how the shell already exposes devtools in dev.
- **Tracked-dict file format**. Plain JSON for v1. If we ever need to track per-feature or per-instance subsets, a richer schema (`{ characters: [...], projects: [...] }`) would help — but for now, one flat list is enough.

## File-touch summary

- `electron/constants.ts` — set `SHELL_CAPABILITIES` to `'SPELLCHECK_DICTIONARY'`.
- `electron/spellcheck-manager.ts` — new file.
- `electron/main.ts` — register three `ipcMain.handle` channels (at app-ready scope, not per-window — see note in §File 3), add a `webContents.on('context-menu', ...)` listener on the main `BrowserWindow`.
- `electron/preload.ts` — extend `window.quilltap` with three methods.
- `package.json` — patch bump.
- `CHANGELOG.md` — top entry.
