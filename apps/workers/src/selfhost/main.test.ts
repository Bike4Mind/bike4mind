import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('the scheduled task isolates the two passes', () => {
  // Source-shape guard: main.ts registers the task inside an unexported boot closure, so the
  // chaining is unreachable from a behavioural test. The regression is silent - dropping either
  // catch type-checks and only shows up as a stranded backlog that stops draining whenever the
  // un-chunked pass's FabFile.find throws.
  it('wraps both sweep calls in their own catch', async () => {
    const src = await readFile(resolve(__dirname, 'main.ts'), 'utf8');
    // runChunkRescueSweep now takes the options object (limit + logger), not a bare logger - only
    // its own call site's shape differs from runStrandedVectorizeRescue's.
    const calls: [string, RegExp][] = [
      ['runChunkRescueSweep', /await runChunkRescueSweep\(\{[^}]*logger: bootLogger[^}]*\}\)(\.catch)?/],
      ['runStrandedVectorizeRescue', /await runStrandedVectorizeRescue\(bootLogger\)(\.catch)?/],
    ];
    for (const [fn, pattern] of calls) {
      const call = src.match(pattern);
      expect(call, `${fn} call site vanished - move or delete this guard with it`).not.toBeNull();
      expect(call![1], `${fn} must not reject out of the tick and skip the other pass`).toBe('.catch');
    }
  });
});

describe('long-running queue registrations', () => {
  // Source-shape guard for the same reason as above: the registrations live in the boot closure.
  // A missing consumer leaves every message parked forever, and a dropped batchSize/runBudgetMs
  // lets a slow run outlive its visibility window and be redelivered mid-run - neither fails loudly.
  const registration = (src: string, queue: string) =>
    src.match(new RegExp(`registerQueueHandler\\(\\s*'${queue}',[\\s\\S]*?\\}\\s*\\)`))?.[0];

  it.each(['driveLakeIngestQueue', 'githubLakeIngestQueue', 'githubLakeRevokeQueue'])(
    'registers %s with the shared single-message, hosted-deadline options',
    async queue => {
      const src = await readFile(resolve(__dirname, 'main.ts'), 'utf8');
      expect(src).toMatch(/const sourceLakeQueueOpts = \{[^}]*runBudgetMs:[^}]*batchSize: 1,[^}]*\}/);
      expect(registration(src, queue), `${queue} is not registered`).toContain('...sourceLakeQueueOpts');
    }
  );

  it('purges one Drive disconnect per dispatch', async () => {
    const src = await readFile(resolve(__dirname, 'main.ts'), 'utf8');
    expect(registration(src, 'driveDisconnectPurgeQueue')).toContain('batchSize: 1');
  });
});

it('preserves five application-event attempts before native dead-letter retention', async () => {
  const source = await readFile(resolve(__dirname, 'main.ts'), 'utf8');
  const broker = await readFile(resolve(__dirname, '../../../../elasticmq.conf'), 'utf8');
  const eventRegistration = source.match(/worker\.registerQueueHandler\(\s*'selfHostEventQueue',[\s\S]*?\n {4}\);/);
  expect(eventRegistration).not.toBeNull();
  expect(eventRegistration![0]).toMatch(/maxReceiveCount: 5/);
  expect(broker).toMatch(
    /selfHostEventQueue\s*\{\s*deadLettersQueue\s*\{\s*name = "selfHostEventQueueDLQ", maxReceiveCount = 5/
  );
});
