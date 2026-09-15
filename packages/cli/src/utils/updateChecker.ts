/**
 * Update checker utility for B4M CLI
 * Checks the NPM registry for newer versions and caches results.
 * Used by the startup banner, `b4m update`, and `b4m doctor` commands.
 */

import { promises as fs, constants as fsConstants } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { homedir } from 'os';
import axios from 'axios';

const CACHE_FILE = path.join(homedir(), '.bike4mind', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@bike4mind/cli/latest';
const FETCH_TIMEOUT_MS = 5000;

/**
 * Canonical global-install command for the CLI.
 * Single source of truth shared by the manual `b4m update` path and the
 * auto-update-on-launch bootstrap so they can never drift.
 */
export const INSTALL_CMD = 'npm install -g @bike4mind/cli@latest';

/**
 * Env var set on the re-exec'd child after an auto-update so it skips the
 * update block and can't loop. Single source of truth for both the reader
 * (shouldAttemptAutoUpdate) and the writer (maybeAutoUpdateOnLaunch).
 */
export const REEXEC_GUARD_ENV = 'B4M_UPDATED_REEXEC';

/**
 * Check whether the global npm prefix is writable by the current user.
 * When it isn't (e.g. Homebrew/system node), `npm install -g` needs sudo -
 * which an unattended auto-updater cannot provide - so callers should fall
 * back to a manual-update notice instead of attempting a silent install.
 * Non-throwing - returns false on any error.
 *
 * Pass `prefix` to reuse an already-resolved `npm config get prefix` (each
 * `execSync` is ~50-200ms); omit it and the prefix is resolved internally.
 */
export async function isNpmPrefixWritable(prefix?: string): Promise<boolean> {
  try {
    const resolved = prefix ?? execSync('npm config get prefix', { encoding: 'utf-8', timeout: 10_000 }).trim();
    if (!resolved) return false;
    await fs.access(resolved, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Cheap, synchronous pre-checks gating auto-update-on-launch. Excludes the
 * async config-file and network lookups so it stays easy to unit-test.
 * Returns false (skip the update) when already re-exec'd this launch, opted
 * out via env, or not attached to an interactive TTY.
 */
export function shouldAttemptAutoUpdate(opts: { env?: NodeJS.ProcessEnv; isTTY?: boolean }): boolean {
  const env = opts.env ?? process.env;
  if (env[REEXEC_GUARD_ENV] === '1') return false; // already updated this launch
  if (env.B4M_AUTO_UPDATE === '0') return false; // env opt-out
  if (!opts.isTTY) return false; // non-interactive / piped
  return true;
}

/**
 * Tri-state auto-update preference, derived from `preferences.autoUpdate`:
 * - `'auto'`  - flag is `true`: install newer versions silently on launch.
 * - `'never'` - flag is `false`: never auto-install; manual `b4m update` only.
 * - `'ask'`   - flag is absent/undefined (the default): prompt on launch when
 *               an update is available, letting the user choose per release.
 */
export type AutoUpdatePreference = 'auto' | 'never' | 'ask';

const CONFIG_FILE = path.join(homedir(), '.bike4mind', 'config.json');

/**
 * Read the user's tri-state `autoUpdate` preference from the global config.
 * Kept deliberately lightweight (no Zod / ConfigStore) because it runs in the
 * bin bootstrap before the app loads. Defaults to `'ask'` (consent-first) when
 * the file or flag is absent/unreadable.
 */
export async function getAutoUpdatePreference(): Promise<AutoUpdatePreference> {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    const value = JSON.parse(raw)?.preferences?.autoUpdate;
    if (value === true) return 'auto';
    if (value === false) return 'never';
    return 'ask';
  } catch {
    return 'ask';
  }
}

/**
 * Persist the user's `autoUpdate` choice (`true` = always, `false` = never).
 *
 * Writes the **global** config file directly - the mirror of how
 * `getAutoUpdatePreference()` reads it - rather than routing through
 * `ConfigStore.save()`. `ConfigStore.load()` merges global -> project -> local,
 * and `ConfigStore.save()` writes that merged result back to the global path;
 * answering "Always"/"Never" inside a project would therefore bake the
 * project's other overrides (model, theme, temperature, ...) into the user's
 * global config as a silent side effect. This call fires during the bin
 * bootstrap any time an update is available, so that blast radius is
 * unacceptable. A direct read-merge-write of only `preferences.autoUpdate`
 * avoids it. If the on-disk file is schema-incomplete, the next
 * `ConfigStore.load()` backfills defaults harmlessly - exactly as
 * `getAutoUpdatePreference` already tolerates a partial file. Best-effort:
 * a failure is swallowed (we simply ask again next launch rather than blocking).
 */
export async function setAutoUpdatePreference(value: boolean): Promise<void> {
  try {
    let raw: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    } catch {
      // ENOENT / unreadable / invalid JSON - start from an empty object.
    }
    const prefs =
      raw.preferences && typeof raw.preferences === 'object' ? (raw.preferences as Record<string, unknown>) : {};
    raw.preferences = { ...prefs, autoUpdate: value };
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(raw, null, 2), 'utf-8');
    await fs.chmod(CONFIG_FILE, 0o600);
  } catch {
    // Best-effort - persisting the preference is non-critical.
  }
}

interface UpdateCheckCache {
  lastChecked: string; // ISO 8601
  latestVersion: string;
  currentVersion: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

/**
 * Compare two semver strings (MAJOR.MINOR.PATCH).
 * Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA < segB) return -1;
    if (segA > segB) return 1;
  }
  return 0;
}

/**
 * Fetch the latest published version from the NPM registry.
 * Returns the version string or null on any error.
 */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await axios.get(NPM_REGISTRY_URL, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { Accept: 'application/json' },
    });
    const version = response.data?.version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Read the cached update check result.
 */
async function readCache(): Promise<UpdateCheckCache | null> {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (
      parsed &&
      typeof parsed.lastChecked === 'string' &&
      typeof parsed.latestVersion === 'string' &&
      typeof parsed.currentVersion === 'string'
    ) {
      return parsed as UpdateCheckCache;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write the update check result to cache.
 */
async function writeCache(cache: UpdateCheckCache): Promise<void> {
  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {
    // Silently fail - cache is best-effort
  }
}

/**
 * Check for updates using cache when fresh.
 * Non-throwing - returns null on any error.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    // Check cache first
    const cache = await readCache();
    if (cache && cache.currentVersion === currentVersion) {
      const age = Date.now() - new Date(cache.lastChecked).getTime();
      if (age < CACHE_TTL_MS) {
        return {
          currentVersion,
          latestVersion: cache.latestVersion,
          updateAvailable: compareSemver(cache.latestVersion, currentVersion) > 0,
        };
      }
    }

    // Cache stale or missing - fetch from registry
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) return null;

    await writeCache({
      lastChecked: new Date().toISOString(),
      latestVersion,
      currentVersion,
    });

    return {
      currentVersion,
      latestVersion,
      updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Force-check for updates (ignores cache).
 * Used by `b4m update` and `b4m doctor`.
 */
export async function forceCheckForUpdate(currentVersion: string): Promise<UpdateCheckResult | null> {
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) return null;

  await writeCache({
    lastChecked: new Date().toISOString(),
    latestVersion,
    currentVersion,
  });

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
  };
}
