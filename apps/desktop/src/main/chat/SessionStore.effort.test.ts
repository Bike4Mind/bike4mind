import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from './SessionStore';

const MODEL = 'test-model';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'b4m-effort-'));
}

/** What a conversation written before the picker existed looks like: no `reasoningEffort` at all. */
const LEGACY_ID = 'c0f24b0e-4e40-4a1d-9a2b-2c7d8f0e1a33';
const LEGACY_SESSION = `{
  "id": "${LEGACY_ID}",
  "title": "an older conversation",
  "model": "gpt-5",
  "createdAt": "2026-09-01T00:00:00.000Z",
  "updatedAt": "2026-09-01T00:00:00.000Z",
  "mode": "chat",
  "approvalMode": "ask",
  "messages": []
}`;

describe('SessionStore reasoning effort', () => {
  it('starts a new conversation at the launch default', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
    const created = await store.create();
    expect(created.reasoningEffort).toBe('high');
  });

  it('leaves a conversation written before the setting existed on the launch default', async () => {
    const directory = await root();
    await writeFile(join(directory, `${LEGACY_ID}.json`), LEGACY_SESSION, 'utf8');

    expect((await new SessionStore(directory, MODEL).get(LEGACY_ID))?.reasoningEffort).toBe('default');
    const benchmark = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'low');
    expect((await benchmark.get(LEGACY_ID))?.reasoningEffort).toBe('low');
  });

  it('keeps a chosen effort across a relaunch that sets a different default', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
    const created = await store.create();
    await store.setReasoningEffort(created.id, 'minimal');

    const relaunched = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'medium');
    expect((await relaunched.get(created.id))?.reasoningEffort).toBe('minimal');
  });

  it('round-trips an explicit default rather than reading it back as "never chosen"', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL, 'launch-one', undefined, undefined, 'high');
    const created = await store.create();
    await store.setReasoningEffort(created.id, 'default');

    expect(JSON.parse(await readFile(join(directory, `${created.id}.json`), 'utf8')).reasoningEffort).toBe('default');
    const relaunched = new SessionStore(directory, MODEL, 'launch-two', undefined, undefined, 'high');
    expect((await relaunched.get(created.id))?.reasoningEffort).toBe('default');
  });

  it('stores an effort the current model cannot use, so switching back restores it', async () => {
    const directory = await root();
    const store = new SessionStore(directory, MODEL, 'launch-one');
    const created = await store.create('claude-5-opus');
    await store.setReasoningEffort(created.id, 'high');
    await store.setModel(created.id, 'gpt-5');

    expect((await store.get(created.id))?.reasoningEffort).toBe('high');
  });

  it('answers null for a session that is gone', async () => {
    const store = new SessionStore(await root(), MODEL);
    expect(await store.setReasoningEffort('d4a2c1b0-0000-4000-8000-000000000000', 'high')).toBeNull();
  });
});
