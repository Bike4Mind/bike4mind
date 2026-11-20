import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotifyScopeStore } from './NotifyScopeStore';

let directory: string;
let filePath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'notify-scope-'));
  filePath = join(directory, 'attention-preferences.json');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('NotifyScopeStore', () => {
  it('defaults to agents only when nothing is stored', async () => {
    expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
  });

  it('falls back to the default for an unreadable or unknown value', async () => {
    await writeFile(filePath, '{"notifyScope":"everything"}');
    expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
    await writeFile(filePath, 'not json');
    expect(await new NotifyScopeStore(filePath).load()).toBe('agents');
  });

  it('keeps a saved scope across a reload', async () => {
    const store = new NotifyScopeStore(filePath);
    await store.load();
    expect(await store.set('all')).toBe('all');
    expect(store.current()).toBe('all');
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ notifyScope: 'all' });
    expect(await new NotifyScopeStore(filePath).load()).toBe('all');
  });
});
