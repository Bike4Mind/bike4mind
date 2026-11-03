import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

const MODEL = 'test-model';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'b4m-generation-store-'));
}

const ID = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a34';

function sessionFile(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: ID,
    title: 'an older conversation',
    model: 'gpt-5',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    mode: 'chat',
    approvalMode: 'ask',
    messages: [],
    ...extra,
  });
}

describe('SessionStore generation settings', () => {
  it('keeps the overrides across a relaunch and a model switch, without touching updatedAt', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL);
    const created = await store.create();
    const before = (await store.get(created.id))?.updatedAt;
    await store.setGeneration(created.id, { temperature: 0.4, maxOutputTokens: 4096 });
    expect((await store.get(created.id))?.updatedAt).toBe(before);
    await store.setModel(created.id, 'another-model');

    const relaunched = new SessionStore(directory, MODEL);
    expect((await relaunched.get(created.id))?.generation).toEqual({ temperature: 0.4, maxOutputTokens: 4096 });
  });

  it('clears the field from the file when the overrides are emptied', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL);
    const created = await store.create();
    await store.setGeneration(created.id, { topP: 0.9 });
    await store.setGeneration(created.id, {});

    expect(JSON.parse(await readFile(join(directory, `${created.id}.json`), 'utf8'))).not.toHaveProperty('generation');
    expect((await store.get(created.id))?.generation).toBeUndefined();
  });

  it('loads a conversation written before the setting existed with no overrides', async () => {
    const directory = await root();
    await writeFile(join(directory, `${ID}.json`), sessionFile(), 'utf8');
    const session = await new SessionStore(directory, MODEL).get(ID);
    expect(session?.title).toBe('an older conversation');
    expect(session).not.toHaveProperty('generation');
  });

  it('keeps only the numeric fields it knows from a damaged file', async () => {
    const directory = await root();
    await writeFile(
      join(directory, `${ID}.json`),
      sessionFile({ generation: { temperature: 'hot', topK: 30, seed: 5 } }),
      'utf8'
    );
    expect((await new SessionStore(directory, MODEL).get(ID))?.generation).toEqual({ topK: 30 });

    await writeFile(join(directory, `${ID}.json`), sessionFile({ generation: [0.5] }), 'utf8');
    expect(await new SessionStore(directory, MODEL).get(ID)).not.toHaveProperty('generation');
  });

  it('answers null for a session that is gone', async () => {
    const store = new SessionStore(await root(), MODEL);
    expect(await store.setGeneration('d4a2c1b0-0000-4000-8000-000000000000', { temperature: 1 })).toBeNull();
  });
});
