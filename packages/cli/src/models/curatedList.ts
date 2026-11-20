import { homedir } from 'node:os';
import path from 'node:path';
import type { HubManifest } from '@bike4mind/common';
import {
  BUNDLED_CURATED_JSON_TEXT,
  CuratedListSource,
  CuratedStore,
  PRODUCTION_CURATED_KEYS,
  curatedStoreRoot,
  loadCuratedManifest,
  resolveCuratedUrl,
  type CuratedCheckStatus,
  type CuratedKey,
} from '@bike4mind/local-models';
import packageJson from '../../package.json';
import { curatedDevKeys } from './curatedDevKey.js';

const CHECK_TIMEOUT_MS = 8000;
// One command never waits longer than this for an update check before it uses the list it has.
const CHECK_BUDGET_MS = 3000;

export interface CliCuratedListOptions {
  /** Use the last verified list on disk (else the bundled one) and make no request, as `--offline` asks. */
  offline: boolean;
  env?: Record<string, string | undefined>;
  /** Where the CLI keeps its state, `~/.bike4mind` by default; tests only. */
  dataDir?: string;
  /** Replaces the production keyring; tests only. */
  keys?: readonly CuratedKey[];
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export interface CuratedOrigin {
  /** The sentence the text output shows. */
  text: string;
  origin: 'bundled' | 'updated';
  sequence: number | null;
  check: CuratedCheckStatus;
  stale: boolean;
  checkedAt: string | null;
}

export interface CliCuratedList {
  /** The list to use; checks for a newer one first when a check is due, for at most a few seconds. */
  manifest(): Promise<HubManifest>;
  /** Checks now, whatever the last check found. */
  refresh(): Promise<void>;
  /** Where the list in use came from; null for a build that has no remote list to offer. */
  origin(): CuratedOrigin | null;
}

/**
 * The CLI's curated list: the bundled one, or a newer signed one fetched from the URL baked at build time and cached.
 * tsdown replaces the two B4M_CURATED build variables, so a published CLI ignores the environment for them. The store
 * opens on first use, so commands that never read the list never touch it.
 */
export function createCliCuratedList(options: CliCuratedListOptions): CliCuratedList {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.error(message));
  const dev = process.env.B4M_CURATED_DEV_KEYS === '1';
  const keys = [...(options.keys ?? PRODUCTION_CURATED_KEYS), ...(dev ? curatedDevKeys() : [])];
  const raw = (dev && env.B4M_CURATED_DEV_URL?.trim()) || process.env.B4M_CURATED_MANIFEST_URL;
  const url = resolveCuratedUrl(raw, dev);
  const offline = options.offline || env.B4M_CURATED === 'off';
  const offered = url !== null && keys.length > 0;
  const dataDir = options.dataDir ?? path.join(homedir(), '.bike4mind');

  let opened: CuratedListSource | undefined;
  const open = () =>
    (opened ??= new CuratedListSource({
      url,
      keys,
      store: new CuratedStore(curatedStoreRoot(dataDir, dev)),
      bundledText: BUNDLED_CURATED_JSON_TEXT,
      load: json => loadCuratedManifest(log, json, { cliVersion: packageJson.version }),
      allowLoopbackHttp: dev,
      network: !offline,
      userAgent: 'Bike4Mind-CLI',
      timeoutMs: CHECK_TIMEOUT_MS,
      now: options.now,
      fetch: options.fetch,
      log,
      onChange: () => {},
    }));

  return {
    async manifest() {
      const source = open();
      await source.loaded();
      const budget = new AbortController();
      // Aborting the requests, rather than leaving them to finish, lets a one-shot process exit at once.
      const timer = setTimeout(() => budget.abort(), CHECK_BUDGET_MS);
      timer.unref();
      try {
        await source.checkIfDue(budget.signal);
      } finally {
        clearTimeout(timer);
      }
      return source.current();
    },
    async refresh() {
      const source = open();
      await source.loaded();
      await source.checkNow();
    },
    origin() {
      if (!offered) return null;
      const view = open().view();
      const from = view.origin === 'updated' ? `Updated online, sequence ${view.sequence}` : 'Bundled with this CLI';
      const notes = [
        offline ? 'updates are off' : view.check === 'failed' && 'the last update check failed',
        view.stale && 'this list is old',
      ].filter(Boolean);
      return {
        text: notes.length > 0 ? `${from} (${notes.join('; ')})` : from,
        origin: view.origin,
        sequence: view.sequence,
        check: offline ? 'off' : view.check,
        stale: view.stale,
        checkedAt: view.checkedAt,
      };
    },
  };
}
