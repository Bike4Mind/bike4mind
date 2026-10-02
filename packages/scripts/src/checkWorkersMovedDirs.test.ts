import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * These apps/client/server directories moved into apps/workers/src. A branch cut before the move
 * that adds a file at the old path merges cleanly and recreates the directory: nothing else fails
 * until the file is imported from apps/client (lint) or an infra handler points at it (deploy).
 * This guard makes that loud at test time and names the new home.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MOVED = [
  { from: 'apps/client/server/events', to: 'apps/workers/src/events' },
  { from: 'apps/client/server/worker', to: 'apps/workers/src/selfhost' },
  { from: 'apps/client/server/cron', to: 'apps/workers/src/cron' },
  { from: 'apps/client/server/jobs', to: 'apps/workers/src/jobs' },
  { from: 'apps/client/server/emailIngestion', to: 'apps/workers/src/emailIngestion' },
] as const;

const OS_LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  // Every file except OS litter a branch switch can leave behind; a stale fixture or .json counts too.
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && !OS_LITTER.has(entry.name))
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)));
}

function infraHandlers(): { file: string; handler: string }[] {
  const infra = path.join(REPO_ROOT, 'infra');
  return fs
    .readdirSync(infra, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts') && !entry.parentPath.includes('node_modules'))
    .flatMap(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [...fs.readFileSync(file, 'utf8').matchAll(/handler:\s*['"`]([^'"`]+)['"`]/g)].map(([, handler]) => ({
        file: path.relative(REPO_ROOT, file),
        handler,
      }));
    });
}

describe('directories moved into apps/workers stay moved', () => {
  it.each(MOVED)('$from has no files (they belong in $to)', ({ from, to }) => {
    expect(filesUnder(path.join(REPO_ROOT, from)), `move these into ${to}`).toEqual([]);
  });

  it('no infra handler points into a moved directory', () => {
    const handlers = infraHandlers();
    // Proves the scan reads real handlers, so an empty result below is not a regex matching nothing.
    expect(handlers.some(({ handler }) => handler.startsWith('apps/workers/src/cron/'))).toBe(true);
    const stale = handlers
      .filter(({ handler }) => MOVED.some(({ from }) => handler.startsWith(`${from}/`)))
      .map(({ file, handler }) => `${file}: ${handler}`);
    expect(stale, 'retarget these handlers at apps/workers/src').toEqual([]);
  });
});
