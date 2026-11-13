import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { notebookExportService } from '@bike4mind/services';
import { runMirrorOnce } from './mirrorCommand';

const { sealMirrorEntries, encodeMirrorCursor, decodeMirrorCursor } = notebookExportService;

const notebook = (id: string, day: number) =>
  ({
    id,
    name: id,
    firstCreated: '2026-01-01T00:00:00.000Z',
    lastUpdated: new Date(Date.UTC(2026, 0, day)).toISOString(),
    tags: [],
    isAutoNamed: false,
    chatHistory: [],
    knowledge: [],
    artifacts: [],
    tools: [],
    agents: [],
  }) as notebookExportService.ExportedNotebook;

/** A feed over fixed notebooks, two per page, resuming from whatever cursor it is handed. */
const feedOf = (all: notebookExportService.ExportedNotebook[]) => async (token: string | undefined) => {
  const from = decodeMirrorCursor(token);
  const rest = token ? all.filter(n => Date.parse(n.lastUpdated) > from.at) : all;
  const { entries, next } = sealMirrorEntries(from, rest.slice(0, 2));
  return {
    entries,
    cursor: encodeMirrorCursor(next),
    hasMore: rest.length > 2,
    ...(rest.length > 2 ? {} : { liveIds: all.map(n => n.id) }),
  };
};

let dir: string;
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('b4m mirror', () => {
  it('writes a v2 bundle and resumes from the saved cursor', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'b4m-mirror-'));
    const all = [notebook('a', 1), notebook('b', 2), notebook('c', 3)];

    expect(await runMirrorOnce(dir, feedOf(all))).toEqual({ pages: 2, notebooks: 3 });

    all.push(notebook('d', 4));
    expect(await runMirrorOnce(dir, feedOf(all))).toEqual({ pages: 1, notebooks: 4 });

    const manifest = JSON.parse(await readFile(path.join(dir, 'bundle', 'manifest.json'), 'utf8'));
    expect(manifest.exportVersion).toBe('2.0.0');
    expect(manifest.collections.notebooks.count).toBe(4);
  });
});
