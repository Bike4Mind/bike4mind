import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from './SessionStore';
import { sessionScopeKey, type SessionScope } from './sessionScope';

/** Session-file reads, counted and optionally slowed, so the tests can see what the index re-parses. */
const reads = vi.hoisted(() => ({ paths: [] as string[], active: 0, peak: 0, delayMs: 0 }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const session = String(args[0]).endsWith('.json');
    if (!session) return actual.readFile(...args);
    reads.paths.push(String(args[0]));
    reads.active++;
    reads.peak = Math.max(reads.peak, reads.active);
    try {
      if (reads.delayMs > 0) await new Promise(resolve => setTimeout(resolve, reads.delayMs));
      return await actual.readFile(...args);
    } finally {
      reads.active--;
    }
  }) as typeof actual.readFile;
  return { ...actual, readFile };
});

const MODEL = 'local:ollama:llama3.2';
const SECRET_TEXT = 'the reply text never belongs in the index';

function reply(outputTokens: number, at = '2026-11-02T15:05:00.000Z'): ChatMessage {
  return {
    id: `r-${outputTokens}-${at}`,
    role: 'assistant',
    content: SECRET_TEXT,
    createdAt: at,
    usage: { inputTokens: 100, outputTokens, rate: { evalTokens: outputTokens, evalMs: 1000 } },
  };
}

async function writeSession(directory: string, id: string, messages: ChatMessage[], model = MODEL): Promise<void> {
  await mkdir(directory, { recursive: true });
  const now = '2026-11-02T15:00:00.000Z';
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({ id, title: id, model, createdAt: now, updatedAt: now, messages }),
    'utf8'
  );
}

function outputOf(buckets: { outputTokens: number }[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
}

describe('SessionStore.localUsageBuckets', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'b4m-local-usage-'));
    reads.paths = [];
    reads.active = 0;
    reads.peak = 0;
    reads.delayMs = 0;
  });

  it('builds over a large history a bounded number of files at a time, keeping only aggregates', async () => {
    const sessions = 120;
    for (let index = 0; index < sessions; index++) await writeSession(root, `s${index}`, [reply(10), reply(5)]);
    reads.delayMs = 5;

    const buckets = await new SessionStore(root, 'hosted-model').localUsageBuckets();

    expect(outputOf(buckets)).toBe(sessions * 15);
    expect(reads.paths).toHaveLength(sessions);
    expect(reads.peak).toBeGreaterThan(1);
    expect(reads.peak).toBeLessThanOrEqual(16);
    const index = await readFile(join(root, '.local-usage-index'), 'utf8');
    expect(index).not.toContain(SECRET_TEXT);
  });

  it('re-parses only the files that changed, across a relaunch too', async () => {
    for (let index = 0; index < 20; index++) await writeSession(root, `s${index}`, [reply(10)]);
    const store = new SessionStore(root, 'hosted-model');
    await store.localUsageBuckets();
    reads.paths = [];

    expect(outputOf(await store.localUsageBuckets())).toBe(200);
    expect(reads.paths).toEqual([]);

    await writeSession(root, 's3', [reply(10), reply(7, '2026-11-02T16:00:00.000Z')]);
    expect(outputOf(await store.localUsageBuckets())).toBe(207);
    expect(reads.paths.map(path => path.split(/[\\/]/).pop())).toEqual(['s3.json']);

    reads.paths = [];
    expect(outputOf(await new SessionStore(root, 'hosted-model').localUsageBuckets())).toBe(207);
    expect(reads.paths).toEqual([]);
  });

  it('prunes a deleted session', async () => {
    await writeSession(root, 'keep', [reply(10)]);
    await writeSession(root, 'gone', [reply(5)]);
    const store = new SessionStore(root, 'hosted-model');
    expect(outputOf(await store.localUsageBuckets())).toBe(15);

    await store.delete('gone');
    expect(outputOf(await store.localUsageBuckets())).toBe(10);
    const index = JSON.parse(await readFile(join(root, '.local-usage-index'), 'utf8')) as { entries: object };
    expect(Object.keys(index.entries)).toEqual(['keep']);
  });

  it('rebuilds from the transcripts when the index is corrupt or from another version', async () => {
    await writeSession(root, 'a', [reply(10)]);
    await writeSession(root, 'b', [reply(5)]);
    await new SessionStore(root, 'hosted-model').localUsageBuckets();

    await writeFile(join(root, '.local-usage-index'), '{not json', 'utf8');
    reads.paths = [];
    expect(outputOf(await new SessionStore(root, 'hosted-model').localUsageBuckets())).toBe(15);
    expect(reads.paths).toHaveLength(2);

    const index = JSON.parse(await readFile(join(root, '.local-usage-index'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(root, '.local-usage-index'), JSON.stringify({ ...index, version: 999 }), 'utf8');
    reads.paths = [];
    expect(outputOf(await new SessionStore(root, 'hosted-model').localUsageBuckets())).toBe(15);
    expect(reads.paths).toHaveLength(2);
  });

  it('skips a transcript that no longer parses and counts it again once it does', async () => {
    await writeSession(root, 'good', [reply(10)]);
    await writeFile(join(root, 'bad.json'), '{"messages": [', 'utf8');
    const store = new SessionStore(root, 'hosted-model');
    expect(outputOf(await store.localUsageBuckets())).toBe(10);

    await writeSession(root, 'bad', [reply(4)]);
    expect(outputOf(await store.localUsageBuckets())).toBe(14);
  });

  it('counts only the current scope', async () => {
    let current: SessionScope | null = {
      environmentUrl: 'b4m-device-local://offline',
      accountId: 'device',
      local: true,
    };
    const account: SessionScope = { environmentUrl: 'https://app.example.invalid', accountId: 'account-a' };
    await writeSession(join(root, sessionScopeKey(current)), 'offline', [reply(3)]);
    await writeSession(join(root, sessionScopeKey(account)), 'online', [reply(40)]);
    const store = new SessionStore(root, 'hosted-model', 'launch', () => current);

    expect(outputOf(await store.localUsageBuckets())).toBe(3);
    current = account;
    expect(outputOf(await store.localUsageBuckets())).toBe(40);
    current = null;
    expect(await store.localUsageBuckets()).toEqual([]);
  });

  it('returns nothing for a directory that does not exist yet', async () => {
    await rm(root, { recursive: true, force: true });
    expect(await new SessionStore(root, 'hosted-model').localUsageBuckets()).toEqual([]);
  });
});
