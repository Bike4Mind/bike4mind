import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SpawnLocationPreference } from './SpawnLocationPreference';

async function preferenceFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'b4m-spawn-location-')), 'spawn-location.json');
}

describe('SpawnLocationPreference', () => {
  it('is a new worktree until the user picks otherwise', async () => {
    expect(await new SpawnLocationPreference(await preferenceFile()).read()).toBe('worktree');
  });

  it('survives a restart', async () => {
    const file = await preferenceFile();
    expect(await new SpawnLocationPreference(file).record('ask')).toBe('ask');

    expect(await new SpawnLocationPreference(file).read()).toBe('ask');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'ask' });
  });

  it('saves two quick changes in order', async () => {
    const file = await preferenceFile();
    const preference = new SpawnLocationPreference(file);
    await expect(Promise.all([preference.record('local'), preference.record('ask')])).resolves.toEqual([
      'local',
      'ask',
    ]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'ask' });
    expect(await preference.read()).toBe('ask');
  });

  it('stores the default for a value Settings does not offer', async () => {
    const file = await preferenceFile();
    expect(await new SpawnLocationPreference(file).record('here')).toBe('worktree');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'worktree' });
  });

  it('reads an unreadable or malformed file as the default', async () => {
    const file = await preferenceFile();
    await writeFile(file, '{not json', 'utf8');
    expect(await new SpawnLocationPreference(file).read()).toBe('worktree');

    await writeFile(file, JSON.stringify({ location: 42 }), 'utf8');
    expect(await new SpawnLocationPreference(file).read()).toBe('worktree');
  });
});
