/**
 * `b4m mirror <dir>`: pull the account's notebooks into a local v2 bundle and keep it current.
 *
 * State (`.mirror-state.json`: cursor plus the latest snapshot of each notebook) lives beside the
 * bundle, so the destination credentials never leave this machine. Every page is verified against
 * the hash chain before it is applied.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyMirrorPage,
  decodeMirrorCursor,
  encodeMirrorCursor,
  mirrorStateToBundle,
  MIRROR_GENESIS_CURSOR,
  type MirrorCursor,
  type MirrorPage,
  type MirrorState,
} from '@bike4mind/services/notebookMirror';
import { ApiClient } from '../auth/ApiClient.js';
import { ConfigStore } from '../storage/ConfigStore.js';
import { requireApiUrl } from '../utils/apiUrl.js';

const STATE_FILE = '.mirror-state.json';

interface PersistedState {
  cursor: string | null;
  notebooks: Record<string, unknown>;
}

export type FetchMirrorPage = (cursor: string | undefined) => Promise<MirrorPage>;

export interface MirrorRunResult {
  pages: number;
  notebooks: number;
}

async function writeAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

async function loadState(dir: string): Promise<{ state: MirrorState; cursor: MirrorCursor }> {
  try {
    const persisted = JSON.parse(await readFile(path.join(dir, STATE_FILE), 'utf8')) as PersistedState;
    return {
      state: new Map(Object.entries(persisted.notebooks)) as MirrorState,
      cursor: decodeMirrorCursor(persisted.cursor ?? undefined),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: new Map(), cursor: MIRROR_GENESIS_CURSOR };
    throw error;
  }
}

/** One sync pass: pages until the feed is drained, then rewrites the bundle. Resumable at any page. */
export async function runMirrorOnce(dir: string, fetchPage: FetchMirrorPage): Promise<MirrorRunResult> {
  const { state, cursor: start } = await loadState(dir);
  let cursor = start;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor === MIRROR_GENESIS_CURSOR ? undefined : encodeMirrorCursor(cursor));
    cursor = applyMirrorPage(state, cursor, page);
    pages++;
    await writeAtomic(
      path.join(dir, STATE_FILE),
      JSON.stringify({ cursor: encodeMirrorCursor(cursor), notebooks: Object.fromEntries(state) })
    );
    if (!page.hasMore) break;
  }
  await mirrorStateToBundle(state, (file, bytes) => writeAtomic(path.join(dir, 'bundle', file), bytes));
  return { pages, notebooks: state.size };
}

export async function handleMirrorCommand(dir: string, opts: { watchSeconds?: number } = {}): Promise<void> {
  const configStore = new ConfigStore();
  const config = await configStore.load();
  const client = new ApiClient(requireApiUrl(config.apiConfig), configStore);
  const fetchPage: FetchMirrorPage = async cursor => {
    const res = await client.post<{ data: MirrorPage }>('/api/notebooks/mirror', { cursor });
    return res.data;
  };
  const target = path.resolve(dir);

  for (;;) {
    const { pages, notebooks } = await runMirrorOnce(target, fetchPage);
    console.log(`Mirrored ${notebooks} notebooks (${pages} page${pages === 1 ? '' : 's'}) to ${target}/bundle`);
    if (!opts.watchSeconds) return;
    await new Promise(resolve => setTimeout(resolve, opts.watchSeconds! * 1000));
  }
}
