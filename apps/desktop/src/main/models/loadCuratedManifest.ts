import { parseHubManifest, type HubManifest } from '@bike4mind/common';
// The repo's one curated list, bundled at build time; the hub schema validates it in this file's test.
import bundled from '../../../../../catalog/model-hub/curated-v2.json';

const EMPTY = { schemaVersion: 2, updatedAt: '1970-01-01T00:00:00Z', families: {}, rankings: {}, entries: [] };
const SHOWN_DROPS = 5;

/**
 * The Curated tab's list, read without ever throwing: a bad envelope gives an empty list, so the rest of the
 * Models screen still registers, and what the reader dropped is logged by path and reason. `input` defaults to the
 * bundled list; a fetched one can replace it here.
 */
export function loadCuratedManifest(warn: (message: string) => void, input: unknown = bundled): HubManifest {
  try {
    const { manifest, dropped } = parseHubManifest(input);
    if (dropped.length > 0) {
      const shown = dropped.slice(0, SHOWN_DROPS).map(drop => `${drop.path}: ${drop.reason}`);
      warn(`MODELS: curated list dropped ${dropped.length} item(s): ${shown.join('; ')}`);
    }
    return manifest;
  } catch (error) {
    warn(`MODELS: curated list unreadable, showing none: ${error instanceof Error ? error.message : 'unknown'}`);
    return parseHubManifest(EMPTY).manifest;
  }
}
