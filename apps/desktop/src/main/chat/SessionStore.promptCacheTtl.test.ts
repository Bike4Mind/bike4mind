import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptCacheTtlPreference } from './PromptCacheTtlPreference';
import { SessionStore } from './SessionStore';

const MODEL = 'claude-opus-5-5';

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'b4m-cache-ttl-'));
}

function storeWith(directory: string, preferenceFile: string, launchId = 'launch-one'): SessionStore {
  return new SessionStore(
    join(directory, 'sessions'),
    MODEL,
    launchId,
    undefined,
    undefined,
    'default',
    new PromptCacheTtlPreference(preferenceFile)
  );
}

describe('PromptCacheTtlPreference', () => {
  it('reads 5 minutes until something is recorded, and the recorded lifetime after', async () => {
    const file = join(await root(), 'prompt-cache-ttl.json');
    expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');

    await new PromptCacheTtlPreference(file).record('1h');
    expect(await new PromptCacheTtlPreference(file).read()).toBe('1h');
  });

  it('falls back to 5 minutes on a file it cannot use', async () => {
    const file = join(await root(), 'prompt-cache-ttl.json');
    await writeFile(file, '{"ttl":"1d"}', 'utf8');
    expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');
    await writeFile(file, 'not json', 'utf8');
    expect(await new PromptCacheTtlPreference(file).read()).toBe('5m');
  });
});

describe('SessionStore prompt cache lifetime', () => {
  it('stores a pick on the conversation and starts the next conversation with it', async () => {
    const directory = await root();
    const preference = join(directory, 'prompt-cache-ttl.json');
    const store = storeWith(directory, preference);
    const first = await store.create();
    expect(first.promptCacheTtl).toBe('5m');

    const summary = await store.setPromptCacheTtl(first.id, '1h');
    expect(summary?.promptCacheTtl).toBe('1h');
    expect(summary?.updatedAt).toBe(first.updatedAt);

    const relaunched = storeWith(directory, preference, 'launch-two');
    expect((await relaunched.get(first.id))?.promptCacheTtl).toBe('1h');
    expect((await relaunched.create()).promptCacheTtl).toBe('1h');
  });

  it('drops a stored value it does not recognise and leaves the preference alone for a missing session', async () => {
    const directory = await root();
    const preference = join(directory, 'prompt-cache-ttl.json');
    const store = storeWith(directory, preference);
    const created = await store.create();
    const file = join(directory, 'sessions', `${created.id}.json`);
    await writeFile(
      file,
      JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), promptCacheTtl: '1d' }),
      'utf8'
    );

    expect((await storeWith(directory, preference, 'launch-two').get(created.id))?.promptCacheTtl).toBeUndefined();
    expect(await store.setPromptCacheTtl('3f0c2c55-9a43-4cf6-8d0e-1b1f0a2b3c4d', '1h')).toBeNull();
    expect(await new PromptCacheTtlPreference(preference).read()).toBe('5m');
  });
});
