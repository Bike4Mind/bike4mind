import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalContextPreference } from './LocalContextPreference';

async function preferenceFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'b4m-local-context-')), 'local-context.json');
}

describe('LocalContextPreference', () => {
  it('is Auto until the user picks a size', async () => {
    expect(await new LocalContextPreference(await preferenceFile()).read()).toEqual({ mode: 'auto' });
  });

  it('survives a restart', async () => {
    const file = await preferenceFile();
    expect(await new LocalContextPreference(file).record({ mode: 'fixed', tokens: 32768 })).toEqual({
      mode: 'fixed',
      tokens: 32768,
    });

    expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'fixed', tokens: 32768 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'fixed', tokens: 32768 });
  });

  it('saves two quick changes without one tripping over the other', async () => {
    const file = await preferenceFile();
    const preference = new LocalContextPreference(file);
    await expect(
      Promise.all([preference.record({ mode: 'fixed', tokens: 32768 }), preference.record({ mode: 'auto' })])
    ).resolves.toEqual([{ mode: 'fixed', tokens: 32768 }, { mode: 'auto' }]);
    expect([{ mode: 'auto' }, { mode: 'fixed', tokens: 32768 }]).toContainEqual(
      JSON.parse(await readFile(file, 'utf8'))
    );
  });

  it('stores Auto for a size Settings does not offer', async () => {
    const file = await preferenceFile();
    expect(await new LocalContextPreference(file).record({ mode: 'fixed', tokens: 1000 })).toEqual({ mode: 'auto' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'auto' });
  });

  it('reads an unreadable or malformed file as Auto', async () => {
    const file = await preferenceFile();
    await writeFile(file, '{not json', 'utf8');
    expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'auto' });

    await writeFile(file, JSON.stringify({ mode: 'fixed', tokens: '32768' }), 'utf8');
    expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'auto' });
  });
});
