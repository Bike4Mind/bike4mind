import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DismissedUpdatePreference } from './DismissedUpdatePreference';

async function scratchFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'b4m-update-notice-')), 'nested', 'update-notice.json');
}

describe('DismissedUpdatePreference', () => {
  it('reads nothing before anything was dismissed', async () => {
    expect(await new DismissedUpdatePreference(await scratchFile()).read()).toBeNull();
  });

  it('round-trips the dismissed version, and a later dismissal replaces it', async () => {
    const path = await scratchFile();
    await new DismissedUpdatePreference(path).record('0.1.11');
    expect(await new DismissedUpdatePreference(path).read()).toBe('0.1.11');

    await new DismissedUpdatePreference(path).record('0.1.12');
    expect(await new DismissedUpdatePreference(path).read()).toBe('0.1.12');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ dismissedVersion: '0.1.12' });
  });

  it('treats a corrupt or wrongly shaped file as nothing dismissed', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'b4m-update-notice-')), 'update-notice.json');
    await writeFile(path, '{not json');
    expect(await new DismissedUpdatePreference(path).read()).toBeNull();
    await writeFile(path, JSON.stringify({ dismissedVersion: 7 }));
    expect(await new DismissedUpdatePreference(path).read()).toBeNull();
  });
});
