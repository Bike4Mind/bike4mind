import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelPreference } from './ModelPreference';

async function preferenceFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'b4m-model-pref-')), 'model-preference.json');
}

describe('ModelPreference', () => {
  it('remembers nothing until the user picks', async () => {
    expect(await new ModelPreference(await preferenceFile()).read()).toBeNull();
  });

  it('survives a restart', async () => {
    const file = await preferenceFile();
    await new ModelPreference(file).record('gpt-5.5');

    expect(await new ModelPreference(file).read()).toBe('gpt-5.5');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'gpt-5.5' });
  });

  it('answers from memory after the first read, so a new conversation never waits on the disk', async () => {
    const file = await preferenceFile();
    const preference = new ModelPreference(file);
    await preference.record('gpt-5.5');
    await writeFile(file, JSON.stringify({ model: 'changed-underneath' }), 'utf8');

    expect(await preference.read()).toBe('gpt-5.5');
  });

  it('treats an unreadable or malformed file as no pick', async () => {
    const file = await preferenceFile();
    await writeFile(file, '{not json', 'utf8');
    expect(await new ModelPreference(file).read()).toBeNull();

    await writeFile(file, JSON.stringify({ model: 42 }), 'utf8');
    expect(await new ModelPreference(file).read()).toBeNull();
  });

  it('ignores a blank pick rather than forgetting the last real one', async () => {
    const file = await preferenceFile();
    const preference = new ModelPreference(file);
    await preference.record('gpt-5.5');
    await preference.record('  ');

    expect(await new ModelPreference(file).read()).toBe('gpt-5.5');
  });
});
