import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static guard for the invariant in `settleStrandedQuests`' docstring: every path
 * that terminates an agent execution has to settle the quests it strands.
 *
 * Both terminators write a terminal status, which drops the execution out of
 * `sweepableStatuses` for good - nothing revisits it, so a caller that forgets
 * to settle leaves its bubbles spinning permanently with no later chance to fix
 * them. There is no runtime seam that would catch that.
 *
 * A directory walk rather than a fixed file list, because the failure mode is a
 * NEW caller that forgets, and a fixed list is exactly what a new caller is not
 * on. Deliberately string-matching: mocking the WebSocket dispatcher deeply
 * enough to prove one call at runtime is expensive and would still be blind to
 * the next one.
 */

// apps/client/server/utils -> apps/client is two levels up.
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH_ROOTS = ['server', 'pages'];

/** Repository methods that put an execution into a terminal status. */
const TERMINATOR = /agentExecutionRepository\s*\.\s*(cleanupStaleActive|markAbandoned)\s*\(/;
const SETTLE = /settleStrandedQuests\s*\(/;

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(full);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      yield full;
    }
  }
}

const terminatingFiles = SEARCH_ROOTS.flatMap(root => [...walkTsFiles(resolve(CLIENT_ROOT, root))])
  .filter(file => TERMINATOR.test(readFileSync(file, 'utf8')))
  .map(file => relative(CLIENT_ROOT, file))
  .sort();

describe('every execution-terminating path settles its stranded quests', () => {
  it('still sees the four known terminating paths, so the walk is not matching nothing', () => {
    // Not an exhaustive list on purpose - a new caller is caught by the check
    // below, not by having to be added here. This only proves the walk works.
    expect(terminatingFiles).toEqual(
      expect.arrayContaining([
        'pages/api/admin/agent-executions/cleanup.ts',
        'server/cron/agentExecutionAbandonedSweep.ts',
        'server/questmaster/v5/runQuestNode.ts',
        'server/utils/startAgentExecution.ts',
      ])
    );
  });

  it.each(terminatingFiles)('%s settles the quests it strands', file => {
    expect(readFileSync(resolve(CLIENT_ROOT, file), 'utf8')).toMatch(SETTLE);
  });
});
