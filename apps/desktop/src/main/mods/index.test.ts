import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkinLoadResult } from './skinFolder';

const harness = vi.hoisted(() => ({
  handlers: new Map<string, () => Promise<unknown>>(),
  loadSkins: vi.fn<() => Promise<SkinLoadResult[]>>(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', on: vi.fn() },
  ipcMain: { handle: (channel: string, handler: () => Promise<unknown>) => harness.handlers.set(channel, handler) },
}));
vi.mock('node:fs', () => ({ watch: vi.fn() }));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(async () => undefined) }));
vi.mock('../windows', () => ({ appWindows: () => [] }));
vi.mock('./skinProtocol', () => ({ registerSkinProtocol: vi.fn() }));
vi.mock('./skinFolder', () => ({ loadSkins: harness.loadSkins }));

const rejected = (id: string): SkinLoadResult => ({ ok: false, id, error: 'bad' });

beforeEach(() => {
  harness.handlers.clear();
  harness.loadSkins.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('registerSkins scan ordering', () => {
  it('keeps the newest scan result when an older scan finishes last', async () => {
    const { registerSkins } = await import('./index');
    registerSkins();
    const list = [...harness.handlers.values()][0];

    let finishOlder!: (results: SkinLoadResult[]) => void;
    harness.loadSkins.mockReturnValueOnce(new Promise(resolve => (finishOlder = resolve)));
    harness.loadSkins.mockResolvedValueOnce([rejected('newer')]);

    const older = list();
    const newer = list();
    expect(await newer).toMatchObject([{ id: 'newer' }]);
    finishOlder([rejected('older')]);
    expect(await older).toMatchObject([{ id: 'newer' }]);
  });
});
