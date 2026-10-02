/**
 * Importing the user's own Chrome cookies into the agent's browser, per site.
 *
 * The agent's jar is deliberately separate from everything the user browses (see
 * BrowserManager). This is the one hole in that wall, and the shape of these types is most of
 * what keeps it a hole rather than a door:
 *
 * - Every call here is renderer -> main, reached from a click. There is no tool and no
 *   model-reachable path; nothing in this file is exposed to a ToolContext.
 * - A site is named by the USER, chosen from their own Chrome profile. Nothing offered in the
 *   chooser comes from the open page, the model or a reply, so "ask the user to click import"
 *   cannot name a site for them.
 * - No type here carries a cookie value, or a cookie name. Counts and hosts only, so nothing
 *   that crosses this boundary could be repeated into a transcript even by accident.
 */

/** At most this many sites in one import: a slip in the chooser should not sweep the profile. */
export const MAX_IMPORT_SITES = 20;

/** A Chrome profile an import can read from. */
export interface ChromeProfile {
  /** The directory under Chrome's user data dir, e.g. 'Default' or 'Profile 1'. */
  dir: string;
  /** What Chrome calls it in its own profile menu, or the directory name when it has none. */
  name: string;
  /** Whether an import with no profile named uses this one. */
  primary: boolean;
}

/** One row of the site chooser: a host, and how many cookies Chrome holds for it. */
export interface ChromeCookieHost {
  host: string;
  cookies: number;
}

/** A site whose cookies are in the agent's jar right now. */
export interface ImportedSite {
  host: string;
  cookies: number;
  /** Which Chrome profile they came from, so the manage list can say. */
  profile: string;
}

/**
 * What the pane needs to draw its standing indicator.
 *
 * `sites` is empty on every launch: imported cookies go in as session cookies and the record of
 * them is held in memory, so neither survives a quit. See CookieImporter.
 */
export interface CookieImportState {
  /** Whether importing is offered at all: macOS, with a Chrome profile on disk. */
  supported: boolean;
  /** Why not, when it is not. Shown in place of the menu item. */
  unsupported: string;
  sites: ImportedSite[];
}

/**
 * Why an import produced nothing. Each is a different thing for the user to do about it, which
 * is why they are not one 'failed'.
 */
export type CookieImportFailure =
  | 'unsupported-platform'
  | 'no-chrome'
  | 'no-profile'
  | 'keychain-denied'
  | 'keychain-missing'
  | 'unreadable'
  | 'nothing-imported'
  | 'failed';

/** Why one cookie was left behind. Reported as counts; never with the cookie it refers to. */
export type CookieSkipReason = 'expired' | 'unsupported-format' | 'undecryptable' | 'rejected';

export interface CookieImportSkip {
  reason: CookieSkipReason;
  cookies: number;
}

export type CookieImportResult =
  | { ok: true; state: CookieImportState; imported: ChromeCookieHost[]; skipped: CookieImportSkip[] }
  | { ok: false; failure: CookieImportFailure; message: string };

export type ChromeProfilesResult =
  { ok: true; profiles: ChromeProfile[] } | { ok: false; failure: CookieImportFailure; message: string };

/** The chooser's list. Reading it decrypts nothing and never touches the Keychain. */
export type ChromeHostsResult =
  { ok: true; hosts: ChromeCookieHost[] } | { ok: false; failure: CookieImportFailure; message: string };

export interface CookieImportRequest {
  profileDir: string;
  hosts: string[];
}

/** What the user is told went wrong, by failure. The UI adds nothing to these. */
export const COOKIE_IMPORT_MESSAGES: Record<CookieImportFailure, string> = {
  'unsupported-platform': 'Importing cookies from Chrome is only supported on macOS.',
  'no-chrome':
    'Google Chrome is not installed on this Mac, or it has never been run. Firefox and Safari ' +
    'store their cookies differently and cannot be imported.',
  'no-profile': 'That Chrome profile no longer has a cookie store. Pick another profile and try again.',
  'keychain-denied':
    'macOS declined access to the Chrome Safe Storage key, so nothing was read and nothing was ' +
    'imported. Try again and allow the Keychain prompt.',
  'keychain-missing':
    'Chrome has no Safe Storage key in this Mac login Keychain, so its cookies cannot be ' +
    'decrypted. This usually means Chrome has not stored a cookie on this machine yet.',
  unreadable: "Chrome's cookie database could not be read. Quitting Chrome and trying again usually clears this.",
  'nothing-imported':
    'Chrome holds no cookies that can be imported for those sites. They may all have expired, ' +
    'or they may be stored in a format this build does not recognise.',
  failed: 'The import did not finish. Nothing was added to the browser.',
};
