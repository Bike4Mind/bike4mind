import { watch } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('registerSkins watcher', () => {
  const flushMkdir = () => vi.advanceTimersByTimeAsync(0);

  async function startWatching() {
    let onChange!: () => void;
    const close = vi.fn();
    const listeners = new Map<string, (error: unknown) => void>();
    vi.mocked(watch).mockImplementation(((_path: string, _options: unknown, listener: () => void) => {
      onChange = listener;
      return { close, on: (event: string, handler: (error: unknown) => void) => listeners.set(event, handler) };
    }) as unknown as typeof watch);
    const { registerSkins } = await import('./index');
    registerSkins();
    await flushMkdir();
    return { onChange: () => onChange(), close, listeners };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    harness.loadSkins.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rescans once after a burst of change events settles', async () => {
    const { onChange } = await startWatching();

    onChange();
    await vi.advanceTimersByTimeAsync(200);
    onChange();
    await vi.advanceTimersByTimeAsync(200);
    onChange();
    expect(harness.loadSkins).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    expect(harness.loadSkins).toHaveBeenCalledTimes(1);
  });

  it('warns once and closes when the watcher errors', async () => {
    const { close, listeners } = await startWatching();

    listeners.get('error')?.(new Error('EMFILE'));

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('SKINS: watcher stopped'));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('toSummary', () => {
  it('never carries the needs-you sound', async () => {
    const { toSummary } = await import('./index');
    const summary = toSummary({
      ok: true,
      skin: {
        manifest: { manifest: 1, id: 'loud', name: 'Loud', version: '1.0.0', kind: 'skin', contract: 1 },
        tokens: { sounds: { finale: 'sounds/finale.ogg', 'needs-you': 'sounds/alarm.ogg' } },
        assets: new Map(),
      },
    });

    expect(summary).toMatchObject({ tokens: { sounds: { finale: 'b4m-skin://loud/sounds/finale.ogg' } } });
    expect(JSON.stringify(summary)).not.toContain('alarm');
  });

  it('reports a colour too close to the needs-you amber as a warning naming its key', async () => {
    const { toSummary } = await import('./index');
    const summary = toSummary({
      ok: true,
      skin: {
        manifest: { manifest: 1, id: 'gold', name: 'Gold', version: '1.0.0', kind: 'skin', contract: 1 },
        tokens: { states: { working: '#f0c050', done: '#3cc8ff' } },
        assets: new Map(),
      },
    });

    expect(summary).toMatchObject({
      status: 'ok',
      warnings: ['states.working is too close to the needs-you colour, so the default is used'],
    });
  });
});
