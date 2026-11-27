import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../../auth/AuthService';
import type { SessionStore } from '../SessionStore';
import type { MediaStore } from '../media/MediaStore';
import { registerProductions } from './registerProductions';
import { ProductionsService } from './ProductionsService';

const ID = 'c'.repeat(24);

afterEach(() => vi.restoreAllMocks());

function setup() {
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const ipc = {
    handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown) => handlers.set(channel, listener),
  };
  const spies = {
    list: vi
      .spyOn(ProductionsService.prototype, 'list')
      .mockResolvedValue({ ok: true, value: { items: [], nextSkip: null } }),
    get: vi
      .spyOn(ProductionsService.prototype, 'get')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
    rename: vi
      .spyOn(ProductionsService.prototype, 'rename')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
    reorder: vi
      .spyOn(ProductionsService.prototype, 'reorder')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
    renders: vi
      .spyOn(ProductionsService.prototype, 'renders')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
    render: vi
      .spyOn(ProductionsService.prototype, 'render')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
    media: vi
      .spyOn(ProductionsService.prototype, 'media')
      .mockResolvedValue({ ok: false, error: { kind: 'not-found', message: '' } }),
  };
  registerProductions({
    ipc: ipc as unknown as IpcMain,
    sessions: {} as SessionStore,
    media: { clearReusableBucket: vi.fn(async () => {}) } as unknown as MediaStore,
    auth: {} as AuthService,
  });
  return { handlers, spies };
}

const valid: Array<[keyof ReturnType<typeof setup>['spies'], string, unknown]> = [
  ['list', IPC_CHANNELS.productionsList, { skip: 20 }],
  ['get', IPC_CHANNELS.productionsGet, { id: ID }],
  ['rename', IPC_CHANNELS.productionsRename, { id: ID, title: 'New' }],
  ['reorder', IPC_CHANNELS.productionsReorder, { id: ID, trackId: 'v1', clipIds: ['a', 'b'] }],
  ['renders', IPC_CHANNELS.productionsRenders, { id: ID }],
  ['render', IPC_CHANNELS.productionsRender, { id: ID, outputIds: ['o1'] }],
  ['media', IPC_CHANNELS.productionsMedia, { fileId: ID }],
];

describe('registerProductions', () => {
  it.each(valid)('%s passes a valid request to the service', async (method, channel, request) => {
    const { handlers, spies } = setup();
    await handlers.get(channel)!({}, request);
    expect(spies[method]).toHaveBeenCalledWith(request);
  });

  it.each(valid)('%s rejects an extra key without calling the service', async (method, channel, request) => {
    const { handlers, spies } = setup();
    await expect(
      Promise.resolve().then(() => handlers.get(channel)!({}, { ...(request as object), extra: 1 }))
    ).rejects.toThrow();
    expect(spies[method]).not.toHaveBeenCalled();
  });

  it.each([
    [IPC_CHANNELS.productionsGet, { id: '../etc' }],
    [IPC_CHANNELS.productionsMedia, { fileId: 'not-an-id' }],
    [
      IPC_CHANNELS.productionsReorder,
      { id: ID, trackId: 'v1', clipIds: Array.from({ length: 501 }, (_, i) => `c${i}`) },
    ],
    [IPC_CHANNELS.productionsReorder, { id: ID, trackId: 'v/1', clipIds: ['a'] }],
    [IPC_CHANNELS.productionsRender, { id: ID, outputIds: [] }],
    [IPC_CHANNELS.productionsRename, { id: ID, title: '   ' }],
  ])('rejects a malformed request on %s', async (channel, request) => {
    const { handlers } = setup();
    await expect(Promise.resolve().then(() => handlers.get(channel)!({}, request))).rejects.toThrow();
  });
});
