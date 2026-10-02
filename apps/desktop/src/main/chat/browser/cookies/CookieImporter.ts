import type { Session } from 'electron';
import {
  COOKIE_IMPORT_MESSAGES,
  MAX_IMPORT_SITES,
  type ChromeHostsResult,
  type ChromeProfilesResult,
  type CookieImportFailure,
  type CookieImportResult,
  type CookieImportSkip,
  type CookieImportState,
  type CookieSkipReason,
  type ImportedSite,
} from '@shared/browserCookies';
import {
  decryptCookieValue,
  deriveChromeKey,
  isImportableSite,
  siteOf,
  sitesCover,
  toImportableCookie,
} from './chromeCookies';
import {
  chromeCookiePath,
  chromeUserDataDir,
  listChromeProfiles,
  readChromeCookieHosts,
  readChromeCookieRows,
  readChromeSafeStoragePassword,
  readFailure,
} from './chromeCookieSource';

function fail(failure: CookieImportFailure): { ok: false; failure: CookieImportFailure; message: string } {
  return { ok: false, failure, message: COOKIE_IMPORT_MESSAGES[failure] };
}

function bump<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/**
 * The user's own Chrome sessions, in the agent's browser, for sites they named.
 *
 * BrowserManager keeps one jar apart from everything the user browses. This deliberately
 * reverses that for named hosts, and the four things that keep the reversal honest live here:
 *
 * - Nothing on this class is reachable from a tool. It is called from IPC handlers that answer
 *   a click; see @shared/browserCookies for why the type surface has no cookie in it.
 * - Only the named sites are read. The filter is a SQL one, so the other sites' values are
 *   never decrypted, and the Keychain password is wiped as soon as a key is derived from it.
 * - Imported cookies go in WITHOUT an expiry, which makes them session cookies: Chromium keeps
 *   those in memory, so they are gone when this process is, whether or not anything tidies up.
 *   `sites` is held in memory for the same reason - on the next launch there is nothing to
 *   remember, because there is nothing left.
 * - No value and no cookie name is logged, returned or thrown out of here. Counts only.
 *
 * What is NOT scoped: the jar is shared by every conversation in this window, so a site
 * imported in one is signed in for all of them. Per-conversation jars would mean a partition
 * per conversation, which is a different change; until then the pane says so in as many words.
 */
export class CookieImporter {
  private readonly sites = new Map<string, ImportedSite>();

  constructor(
    private readonly jar: () => Session,
    private readonly onChanged: (state: CookieImportState) => void = () => undefined
  ) {}

  async state(): Promise<CookieImportState> {
    const sites = [...this.sites.values()].sort((a, b) => a.host.localeCompare(b.host));
    if (process.platform !== 'darwin') {
      return { supported: false, unsupported: COOKIE_IMPORT_MESSAGES['unsupported-platform'], sites };
    }
    const profiles = await listChromeProfiles().catch(() => []);
    if (profiles.length === 0) {
      return { supported: false, unsupported: COOKIE_IMPORT_MESSAGES['no-chrome'], sites };
    }
    return { supported: true, unsupported: '', sites };
  }

  async profiles(): Promise<ChromeProfilesResult> {
    if (process.platform !== 'darwin') return fail('unsupported-platform');
    const profiles = await listChromeProfiles().catch(() => []);
    if (profiles.length === 0) return fail('no-chrome');
    return { ok: true, profiles };
  }

  /** The chooser's list for one profile. No Keychain prompt and no decryption; see the source. */
  async hosts(profileDir: string): Promise<ChromeHostsResult> {
    const profile = await this.resolveProfile(profileDir);
    if (!profile.ok) return profile;
    try {
      return { ok: true, hosts: await readChromeCookieHosts(profile.cookiePath) };
    } catch (err) {
      return fail(readFailure(err));
    }
  }

  /**
   * Copy the named sites' cookies into the jar.
   *
   * The Keychain prompt happens here, once, and unlocks everything Chrome has - so the sites
   * are settled before it is asked for, and what the key is then used on is the rows the
   * database already narrowed to those sites.
   */
  async importSites(profileDir: string, requested: readonly string[]): Promise<CookieImportResult> {
    const wanted = [...new Set(requested.map(siteOf))].filter(isImportableSite);
    if (wanted.length === 0 || wanted.length > MAX_IMPORT_SITES) return fail('failed');

    const profile = await this.resolveProfile(profileDir);
    if (!profile.ok) return profile;

    const keychain = await readChromeSafeStoragePassword();
    if (!keychain.ok) return fail(keychain.failure);
    const key = deriveChromeKey(keychain.password);
    keychain.password.fill(0);

    try {
      const rows = await readChromeCookieRows(profile.cookiePath, wanted);
      const jar = this.jar().cookies;
      const now = Math.floor(Date.now() / 1000);
      const imported = new Map<string, number>();
      const skipped = new Map<CookieSkipReason, number>();

      for (const row of rows) {
        const decrypted = decryptCookieValue(row.encryptedValue, row.hostKey, key);
        if (!decrypted.ok) {
          bump(skipped, decrypted.reason);
          continue;
        }
        const mapped = toImportableCookie(row, decrypted.value, now);
        if (!mapped.ok) {
          bump(skipped, mapped.reason);
          continue;
        }
        try {
          await jar.set(mapped.cookie);
        } catch {
          // Deliberately swallowed rather than reported: whatever Chromium objected to, its
          // message names the cookie, and a cookie's name is the one thing that must not come
          // back out of the jar on an error path.
          bump(skipped, 'rejected');
          continue;
        }
        bump(imported, siteOf(row.hostKey));
      }

      if (imported.size === 0) return fail('nothing-imported');
      for (const [host, cookies] of imported) this.sites.set(host, { host, cookies, profile: profile.name });
      return {
        ok: true,
        state: await this.publish(),
        imported: [...imported].map(([host, cookies]) => ({ host, cookies })),
        skipped: [...skipped].map(([reason, cookies]): CookieImportSkip => ({ reason, cookies })),
      };
    } catch (err) {
      return fail(readFailure(err));
    } finally {
      key.fill(0);
    }
  }

  /** Drop one site: its cookies out of the jar, and the site off the pane's indicator. */
  async forget(host: string): Promise<CookieImportState> {
    const site = siteOf(host);
    if (!this.sites.has(site)) return this.state();
    await this.removeCookiesFor(site);
    this.sites.delete(site);
    return this.publish();
  }

  /**
   * Empty the jar - all of it, not only the rows an import added.
   *
   * A site signed in with an imported cookie goes on to set its own, and may keep as much again
   * in local storage or IndexedDB; a cache can answer the next request with a signed-in
   * response on its own. Clearing only what was added would leave every one of those and still
   * tell the user they were signed out. The cost is the agent's own dev-server logins, which is
   * the right way round: a clear worth reaching for is one the user can believe.
   */
  async clear(): Promise<CookieImportState> {
    const jar = this.jar();
    await jar.clearStorageData();
    await jar.clearAuthCache();
    await jar.clearCache();
    this.sites.clear();
    return this.publish();
  }

  /**
   * Belt and braces for the quit scope.
   *
   * An imported cookie has no expiry and so is never written to disk, which is what actually
   * makes the retention quit-scoped. This removes them anyway, for the day that stops being
   * true - and it touches only the imported sites, because the rest of the jar is the agent's
   * own work and a quit is not a reason to throw it away.
   */
  async clearOnQuit(): Promise<void> {
    for (const site of [...this.sites.keys()]) await this.removeCookiesFor(site).catch(() => undefined);
    this.sites.clear();
  }

  /** Whether reaching this url means reaching it as the user. Drives the tools' approvals. */
  usesImportedCookies(url: string): boolean {
    return this.sites.size > 0 && sitesCover(this.sites.keys(), url);
  }

  private async removeCookiesFor(site: string): Promise<void> {
    const jar = this.jar().cookies;
    for (const cookie of await jar.get({})) {
      const host = siteOf(cookie.domain ?? '');
      if (host !== site) continue;
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      await jar.remove(url, cookie.name).catch(() => undefined);
    }
  }

  private async publish(): Promise<CookieImportState> {
    const state = await this.state();
    this.onChanged(state);
    return state;
  }

  private async resolveProfile(
    profileDir: string
  ): Promise<
    { ok: true; name: string; cookiePath: string } | { ok: false; failure: CookieImportFailure; message: string }
  > {
    if (process.platform !== 'darwin') return fail('unsupported-platform');
    const profiles = await listChromeProfiles().catch(() => []);
    if (profiles.length === 0) return fail('no-chrome');
    // An empty name means "whichever one you default to"; a name that is no longer there is a
    // failure rather than a reason to quietly read a DIFFERENT profile's cookies.
    const profile = profileDir
      ? profiles.find(entry => entry.dir === profileDir)
      : (profiles.find(entry => entry.primary) ?? profiles[0]);
    if (!profile) return fail('no-profile');
    return { ok: true, name: profile.name, cookiePath: chromeCookiePath(chromeUserDataDir(), profile.dir) };
  }
}
