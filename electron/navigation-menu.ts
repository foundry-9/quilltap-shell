/**
 * Native navigation menus built from the server's navigation listing
 * (`GET /api/v1/system/navigation`).
 *
 * The contract lives in quilltap-server's
 * `docs/developer/features/complete/navigation-menus-shell-contract.md`.
 * In short: every label and item comes from the listing; the shell keeps only
 * the accelerator map below, and the legacy Navigate menu for servers that
 * have no listing.
 */
import type { MenuItemConstructorOptions } from 'electron';
import {
  KNOWN_NAVIGATION_VERSIONS,
  NavigationListing,
  NavigationListingGroup,
  NavigationListingItem,
} from './types';

/** How long to wait for the listing before giving up and keeping the legacy menu */
const NAVIGATION_FETCH_TIMEOUT_MS = 5000;

/**
 * The accelerators operators already rely on, keyed by item id. They decorate
 * items the listing provides and never add one. Add none here (contract §1).
 */
const NAV_ACCELERATORS: Readonly<Record<string, string>> = {
  home: 'CmdOrCtrl+Shift+H',
  projects: 'CmdOrCtrl+Shift+P',
  files: 'CmdOrCtrl+Shift+F',
  characters: 'CmdOrCtrl+Shift+C',
  chats: 'CmdOrCtrl+Shift+S',
  settings: 'CmdOrCtrl+,',
};

/**
 * The Navigate menu as it was before the listing existed, kept for servers
 * that do not serve one (contract §6).
 */
const LEGACY_NAVIGATE_ITEMS: readonly NavigationListingItem[] = [
  { id: 'home', label: 'Home', type: 'destination', href: '/' },
  { id: 'projects', label: 'Projects', type: 'destination', href: '/prospero' },
  { id: 'files', label: 'Files', type: 'destination', href: '/files' },
  { id: 'characters', label: 'Characters', type: 'destination', href: '/aurora' },
  { id: 'chats', label: 'Chats', type: 'destination', href: '/salon' },
  { id: 'settings', label: 'Settings', type: 'destination', href: '/settings' },
  { id: 'profile', label: 'Profile', type: 'destination', href: '/profile' },
  { id: 'about', label: 'About', type: 'destination', href: '/about' },
];

export type NavItemActivator = (item: NavigationListingItem) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one listing item. Items of an unknown `type`, or missing the fields
 * their type requires, are dropped; unknown fields are ignored.
 */
function parseItem(raw: unknown): NavigationListingItem | null {
  if (!isRecord(raw)) return null;
  const { id, label, type, href } = raw;
  if (typeof id !== 'string' || !id || typeof label !== 'string' || !label) return null;
  if (type === 'destination') {
    return typeof href === 'string' && href ? { id, label, type, href } : null;
  }
  if (type === 'action') {
    return { id, label, type };
  }
  return null;
}

function parseItems(raw: unknown[]): NavigationListingItem[] {
  return raw.map(parseItem).filter((item): item is NavigationListingItem => item !== null);
}

/**
 * Turn a response body into a listing, or null when it cannot be used: not an
 * object, missing the `top`/`groups`/`pinned` arrays, or a version this shell
 * does not know.
 */
export function parseNavigationListing(body: unknown): NavigationListing | null {
  if (!isRecord(body)) return null;
  const { version, top, groups, pinned } = body;
  if (typeof version !== 'number' || !(KNOWN_NAVIGATION_VERSIONS as readonly number[]).includes(version)) {
    console.warn('[Navigation] Listing version not recognised, keeping legacy menu:', version);
    return null;
  }
  if (!Array.isArray(top) || !Array.isArray(groups) || !Array.isArray(pinned)) return null;

  const parsedGroups: NavigationListingGroup[] = [];
  for (const group of groups) {
    if (!isRecord(group)) continue;
    const { id, label, items } = group;
    if (typeof id !== 'string' || typeof label !== 'string' || !label || !Array.isArray(items)) continue;
    parsedGroups.push({ id, label, items: parseItems(items) });
  }

  return { version, top: parseItems(top), groups: parsedGroups, pinned: parseItems(pinned) };
}

/**
 * Fetch the navigation listing from the main process. No authentication is
 * needed, and a main-process request sends no Origin header, so the server's
 * origin gate lets it through. Any failure resolves to null.
 */
export async function fetchNavigationListing(baseUrl: string): Promise<NavigationListing | null> {
  const url = new URL('/api/v1/system/navigation', baseUrl).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(NAVIGATION_FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      console.log(`[Navigation] Listing unavailable (HTTP ${response.status}), keeping legacy menu`);
      return null;
    }
    const listing = parseNavigationListing(await response.json());
    if (!listing) console.warn('[Navigation] Listing could not be used, keeping legacy menu');
    return listing;
  } catch (error) {
    console.warn('[Navigation] Listing fetch failed, keeping legacy menu:', error instanceof Error ? error.message : error);
    return null;
  }
}

function toMenuItems(items: readonly NavigationListingItem[], activate: NavItemActivator): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    label: item.label,
    accelerator: NAV_ACCELERATORS[item.id],
    click: () => activate(item),
  }));
}

/**
 * The menus that sit between Edit and View: Go plus one per group when a
 * listing is in hand, otherwise the legacy Navigate menu.
 */
export function buildNavigationMenus(
  listing: NavigationListing | null,
  activate: NavItemActivator,
): MenuItemConstructorOptions[] {
  if (!listing) {
    return [{ label: 'Navigate', submenu: toMenuItems(LEGACY_NAVIGATE_ITEMS, activate) }];
  }

  const menus: MenuItemConstructorOptions[] = [];

  const top = toMenuItems(listing.top, activate);
  const pinned = toMenuItems(listing.pinned, activate);
  const goItems = top.length && pinned.length
    ? [...top, { type: 'separator' as const }, ...pinned]
    : [...top, ...pinned];
  if (goItems.length) menus.push({ label: 'Go', submenu: goItems });

  for (const group of listing.groups) {
    if (group.items.length) {
      menus.push({ label: group.label, submenu: toMenuItems(group.items, activate) });
    }
  }

  return menus;
}
