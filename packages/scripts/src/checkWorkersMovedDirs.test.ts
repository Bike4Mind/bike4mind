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

/**
 * Modules moved out of a directory that can't be guarded whole: apps/client/server/queueHandlers
 * keeps questProcessor (the in-process chat-completion path imports it), so it never empties.
 * Guarded per module instead, by file stem.
 */
const MOVED_MODULES = [
  {
    from: 'apps/client/server/queueHandlers',
    to: 'apps/workers/src/queueHandlers',
    stems: [
      'agentProactiveMessage',
      'dataLakeBatchRetryGating',
      'dataLakeResearchRun',
      'dataLakeTaxonomyAnalysis',
      'emailBatch',
      'emailJobOrchestrator',
      'emailTestRecipients',
      'fabFileChunk',
      'fabFileVectorize',
      'generationCallback',
      'githubWebhook',
      'lakeInconsistencyModelDetection',
      'lakeMemoryExtraction',
      'notebookCuration',
      'notifySlackIndexingComplete',
      'researchEngineQueue',
      'resumeEmbeddingSpace',
      'sanitizeWebhookError',
      'slackExport',
      'sreAnalysis',
      'sreFix',
      'sreJob',
      'sreRevision',
      'vectorizeStrandRecovery',
      'webhookDelivery',
    ],
  },
] as const;

const MOVED_MODULE_CASES = MOVED_MODULES.flatMap(({ from, to, stems }) => stems.map(stem => ({ from, to, stem })));

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
        handler: handler.replace(/^\.\//, ''),
      }));
    });
}

describe('directories and modules moved into apps/workers stay moved', () => {
  it.each(MOVED)('$from has no files (they belong in $to)', ({ from, to }) => {
    expect(filesUnder(path.join(REPO_ROOT, from)), `move these into ${to}`).toEqual([]);
  });

  it.each(MOVED_MODULE_CASES)('$stem has no file left in $from (it belongs in $to)', ({ from, to, stem }) => {
    const dir = path.join(REPO_ROOT, from);
    const leftovers = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter(name => name.startsWith(`${stem}.`))
          .map(name => `${from}/${name}`)
      : [];
    expect(leftovers, `move these into ${to}`).toEqual([]);
  });

  it('no infra handler points into a moved directory or at a moved module', () => {
    const handlers = infraHandlers();
    // Proves the scan reads real handlers, so an empty result below is not a regex matching nothing.
    expect(handlers.some(({ handler }) => handler.startsWith('apps/workers/src/cron/'))).toBe(true);
    // Each moved Lambda's own infra file must be scanned too, or a stale handler there passes unseen.
    expect(handlers.map(({ handler }) => handler)).toEqual(
      expect.arrayContaining([
        'apps/workers/src/jobs/dataSyncerHandler.handler',
        'apps/workers/src/emailIngestion/emailParser.dispatch',
        'apps/workers/src/emailIngestion/emailAnalyzer.dispatch',
        'apps/workers/src/queueHandlers/sreJob.dispatch',
        // infra/emailMarketing.ts, which no other moved handler lives in.
        'apps/workers/src/queueHandlers/emailBatch.dispatch',
      ])
    );
    const stale = handlers
      .filter(
        ({ handler }) =>
          MOVED.some(({ from }) => handler.startsWith(`${from}/`)) ||
          MOVED_MODULE_CASES.some(({ from, stem }) => handler.startsWith(`${from}/${stem}.`))
      )
      .map(({ file, handler }) => `${file}: ${handler}`);
    expect(stale, 'retarget these handlers at apps/workers/src').toEqual([]);
  });
});
