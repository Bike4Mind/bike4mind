import { watch, unwatchFile } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeSettings } from './ClaudeCodeSettings';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch), unwatchFile: vi.fn(actual.unwatchFile) };
});

describe('ClaudeCodeSettings failure and replacement handling', () => {
  let home: string;
  let settings: ClaudeCodeSettings;
  const warn = vi.fn<(message: string) => void>();
  const changed = vi.fn<() => void>();

  beforeEach(async () => {
    vi.mocked(watch).mockClear();
    vi.mocked(unwatchFile).mockClear();
    warn.mockReset();
    changed.mockReset();
    home = await mkdtemp(join(tmpdir(), 'claude-settings-'));
    settings = new ClaudeCodeSettings({
      home,
      managedPath: join(home, 'managed.json'),
      logger: { warn },
      onChange: changed,
      debounceMs: 10,
    });
  });
  afterEach(async () => {
    settings.dispose();
    await rm(home, { recursive: true, force: true });
  });

  it('distinguishes a read failure from a missing file and logs it', async () => {
    await mkdir(join(home, '.claude', 'settings.json'), { recursive: true });
    await settings.loadUser();
    expect(settings.filesFor(null).find(file => file.id === 'cc-user')?.status).toBe('unreadable');
    expect(settings.filesFor(null).find(file => file.id === 'cc-user-local')?.status).toBe('missing');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read'));
  });

  it.each(['{broken', 'null', '{"permissions":{"deny":"Bash(rm:*)"}}'])(
    'rejects malformed settings: %s',
    async text => {
      await mkdir(join(home, '.claude'));
      await writeFile(join(home, '.claude', 'settings.json'), text);
      await settings.loadUser();
      expect(settings.filesFor(null).find(file => file.id === 'cc-user')?.status).toBe('unreadable');
      expect(warn).toHaveBeenCalled();
    }
  );

  it('polls rules when native watching fails and removes polling on dispose', async () => {
    const path = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'));
    await writeFile(path, '{"permissions":{"deny":["Bash(rm:*)"]}}');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(watch).mockImplementation(() => {
      throw new Error('EMFILE');
    });
    try {
      await settings.loadUser();
    } finally {
      vi.mocked(watch).mockImplementation(actual.watch);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('polling settings files instead'));
    await writeFile(path, '{"permissions":{"deny":["Bash(curl:*)"]}}');
    await vi.waitFor(
      () => expect(settings.filesFor(null).find(file => file.id === 'cc-user')?.lists.deny).toEqual(['Bash(curl:*)']),
      { timeout: 4000 }
    );
    expect(changed).toHaveBeenCalled();
    settings.dispose();
    expect(unwatchFile).toHaveBeenCalledWith(path, expect.any(Function));
  });

  it('watches edits after replacing the settings directory', async () => {
    const folder = join(home, '.claude');
    await mkdir(folder);
    await writeFile(join(folder, 'settings.json'), '{"permissions":{"deny":["Bash(rm:*)"]}}');
    await settings.loadUser();
    // Let the OS finish installing watchers before simulating editor operations.
    await new Promise(resolve => setTimeout(resolve, 100));
    await rename(folder, join(home, 'old-claude'));
    await mkdir(folder);
    await writeFile(join(folder, 'settings.json'), '{"permissions":{"deny":["Bash(curl:*)"]}}');
    await vi.waitFor(
      () => expect(settings.filesFor(null).find(file => file.id === 'cc-user')?.lists.deny).toEqual(['Bash(curl:*)']),
      { timeout: 5000 }
    );
    await writeFile(join(folder, 'settings.json'), '{"permissions":{"deny":["Bash(git push:*)"]}}');
    await vi.waitFor(
      () =>
        expect(settings.filesFor(null).find(file => file.id === 'cc-user')?.lists.deny).toEqual(['Bash(git push:*)']),
      { timeout: 5000 }
    );
  });

  it('loads managed policies installed after startup and watches a replaced managed directory', async () => {
    settings.dispose();
    const folder = join(home, 'managed');
    const path = join(folder, 'managed-settings.json');
    settings = new ClaudeCodeSettings({
      home,
      managedPath: path,
      logger: { warn },
      onChange: changed,
      debounceMs: 10,
    });
    await settings.loadUser();
    expect(settings.filesFor(null).find(file => file.id === 'cc-managed')?.status).toBe('missing');
    await new Promise(resolve => setTimeout(resolve, 100));
    await mkdir(folder);
    await writeFile(path, '{"permissions":{"deny":["Bash(rm:*)"]}}');
    await vi.waitFor(
      () => expect(settings.filesFor(null).find(file => file.id === 'cc-managed')?.lists.deny).toEqual(['Bash(rm:*)']),
      { timeout: 5000 }
    );
    await rename(folder, join(home, 'old-managed'));
    await mkdir(folder);
    await writeFile(path, '{"permissions":{"deny":["Bash(curl:*)"]}}');
    await vi.waitFor(
      () => expect(settings.filesFor(null).find(file => file.id === 'cc-managed')?.lists.deny).toEqual(['Bash(curl:*)']),
      { timeout: 5000 }
    );
    await writeFile(path, '{"permissions":{"deny":["Bash(git push:*)"]}}');
    await vi.waitFor(
      () => expect(settings.filesFor(null).find(file => file.id === 'cc-managed')?.lists.deny).toEqual(['Bash(git push:*)']),
      { timeout: 5000 }
    );
  });
});
