import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, ImportStateStore } from './ImportStateStore';

const slowRead = vi.hoisted(() => ({ gate: null as Promise<void> | null }));

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const gate = slowRead.gate;
      const contents = await actual.readFile(...args);
      if (gate) await gate;
      return contents;
    }) as typeof actual.readFile,
  };
});

describe('ImportStateStore settings', () => {
  it('keeps a write that lands while the file is still being read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'import-state-'));
    const settingsPath = join(root, 'claude-import.json');
    await writeFile(settingsPath, JSON.stringify(DEFAULT_SETTINGS), 'utf8');
    const store = new ImportStateStore(settingsPath, join(root, 'state'));

    let release!: () => void;
    slowRead.gate = new Promise<void>(resolve => (release = resolve));
    const reading = store.readSettings();
    slowRead.gate = null;
    await store.writeSettings({ ...DEFAULT_SETTINGS, web: { enabled: true } });
    release();

    expect((await reading).web.enabled).toBe(true);
    expect((await store.readSettings()).web.enabled).toBe(true);
  });
});
