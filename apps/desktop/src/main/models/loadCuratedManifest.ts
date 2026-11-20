import { parseHubManifest, type HubManifest } from '@bike4mind/common';
import { BUNDLED_CURATED_TEXT } from './curated/bundled';

const EMPTY = { schemaVersion: 2, updatedAt: '1970-01-01T00:00:00Z', families: {}, rankings: {}, entries: [] };
const SHOWN_DROPS = 5;

function parseBundled(): unknown {
  try {
    return JSON.parse(BUNDLED_CURATED_TEXT);
  } catch {
    return undefined;
  }
}

// The repo's one curated list, bundled at build time; the hub schema validates it in this file's test.
const bundled = parseBundled();

const versionParts = (version: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1, 4).map(Number);

/** True when `version` (major.minor.patch, any suffix ignored) is below `minimum`. */
export function olderThan(version: string, minimum: string): boolean {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (have.length !== 3 || need.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] < need[i];
  return false;
}

export interface LoadCuratedOptions {
  /** This app's version; entries whose `minDesktopVersion` is newer are left out. */
  desktopVersion?: string;
}

/**
 * The Curated tab's list from `input` (a fetched list can be passed here), never throwing: unreadable input falls
 * back to the bundled list, and what the reader dropped is logged by path and reason.
 */
export function loadCuratedManifest(
  warn: (message: string) => void,
  input: unknown = bundled,
  options: LoadCuratedOptions = {}
): HubManifest {
  try {
    const { manifest, dropped } = parseHubManifest(input);
    const { desktopVersion } = options;
    const tooNew = desktopVersion
      ? manifest.entries.filter(entry => entry.minDesktopVersion && olderThan(desktopVersion, entry.minDesktopVersion))
      : [];
    for (const entry of tooNew)
      dropped.push({ path: `entries.${entry.id}`, reason: `needs Desktop ${entry.minDesktopVersion} or newer` });
    if (dropped.length > 0) {
      const shown = dropped.slice(0, SHOWN_DROPS).map(drop => `${drop.path}: ${drop.reason}`);
      warn(`MODELS: curated list dropped ${dropped.length} item(s): ${shown.join('; ')}`);
    }
    return tooNew.length === 0
      ? manifest
      : Object.freeze({ ...manifest, entries: manifest.entries.filter(entry => !tooNew.includes(entry)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown';
    if (input !== bundled) {
      warn(`MODELS: curated list unreadable, showing the bundled one: ${reason}`);
      return loadCuratedManifest(warn, bundled, options);
    }
    warn(`MODELS: bundled curated list unreadable, showing none: ${reason}`);
    return parseHubManifest(EMPTY).manifest;
  }
}
