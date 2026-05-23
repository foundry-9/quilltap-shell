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
 * words (added via the context menu) untouched as long as they don't appear
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
