import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { IPC_CHANNELS } from '@shared/ipc';
import type { StudioDraft, StudioLiveState, StudioReview } from '@shared/studioIpc';
import type { AuthService } from '../../auth/AuthService';
import type { ChatService } from '../ChatService';
import type { ModelCatalog } from '../ModelCatalog';
import { AttachmentStore } from '../AttachmentStore';
import { SessionStore } from '../SessionStore';
import { MediaApiClient } from '../media/MediaApiClient';
import { MediaStore } from '../media/MediaStore';
import { registerStudio } from './registerStudio';

const showOpenDialog = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ app: { once: vi.fn() }, dialog: { showOpenDialog }, shell: {} }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const remove of cleanup.splice(0)) await remove();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'studio-ipc-'));
  let account = { environmentUrl: 'https://example.test', accountId: 'a' };
  const sessions = new SessionStore(join(directory, 'sessions'), 'model', 'launch', () => account);
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const handle: IpcMain['handle'] = (channel, listener) => {
    handlers.set(channel, listener);
  };
  const api = new AuthenticatedApiClient({
    baseUrl: account.environmentUrl,
    tokenStore: {
      getAuthTokens: async () => null,
      setAuthTokens: async () => {},
      clearAuthTokens: async () => {},
      isAuthenticated: async () => false,
    },
    oauthClient: { refreshToken: vi.fn() },
    logger,
    reauthMessages: { refreshFailed: 'refresh', stillUnauthorized: 'unauthorized' },
  });
  const paid = vi.fn<(config: InternalAxiosRequestConfig) => void>();
  api.getAxiosInstance().defaults.adapter = (async config => {
    let data: unknown;
    switch (config.url) {
      case '/api/v1/image-models':
        data = { models: [{ id: 'gpt-image-2' }] };
        break;
      case '/api/v1/music-models':
        data = { models: [] };
        break;
      case '/api/ai/audio-providers':
        data = { speech: [], soundEffects: [] };
        break;
      case '/api/ai/elevenlabs-voices':
        data = { voices: [] };
        break;
      case '/api/v1/image-jobs': {
        paid(config);
        data = { group_id: 'group', data: [queuedImageJob] };
        break;
      }
      case '/api/v1/image-jobs/remote':
        data = queuedImageJob;
        break;
      default:
        throw new Error(`Unexpected fixture request ${config.url}`);
    }
    return { status: 200, statusText: 'OK', headers: {}, data, config };
  }) satisfies AxiosAdapter;
  const prepareText = vi.fn<ChatService['prepareStudioText']>(async () => 'Prepared garden');
  const integration = registerStudio({
    ipc: { handle } as unknown as IpcMain,
    directory,
    sessions,
    logger,
    service: { studioContextRoots: async () => [], prepareStudioText: prepareText } as unknown as ChatService,
    auth: { getSessionBoundApiClient: () => api } as unknown as AuthService,
    attachments: new AttachmentStore(join(directory, 'attachments'), logger),
    media: new MediaStore(join(directory, 'media')),
    models: { listVideoModels: async () => [] } as unknown as ModelCatalog,
    videoJobs: async () => [],
    changed: vi.fn(),
  });
  cleanup.push(async () => {
    integration.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const invoke = async (channel: string, input: unknown): Promise<unknown> => {
    const listener = handlers.get(channel);
    if (!listener) throw new Error('Handler not registered');
    return listener({} as IpcMainInvokeEvent, input);
  };
  const session = await sessions.create();
  const state = (await invoke(IPC_CHANNELS.studioGet, session.id)) as StudioLiveState;
  const draft: StudioDraft = {
    sessionId: session.id,
    workspaceId: state.workspace.workspaceId,
    revision: state.revision,
    kind: 'image',
    prompt: 'A garden',
    selection: { mode: 'none' },
    settings: { model: 'gpt-image-2', count: 1 },
  };
  return {
    integration,
    invoke,
    draft,
    paid,
    api,
    prepareText,
    switchAccount: () => {
      account = { ...account, accountId: 'b' };
    },
  };
}

const queuedImageJob = {
  id: 'remote',
  object: 'image_generation',
  state: 'pending',
  model: 'gpt-image-2',
  mode: 'generate',
  prompt: 'Prepared garden',
  group_id: 'group',
  source: 'studio',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('registered Studio authorization', () => {
  it('uploads a reference image the user picked although the session has no granted folders', async () => {
    const { invoke, draft } = await setup();
    const directory = await mkdtemp(join(tmpdir(), 'studio-reference-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const image = join(directory, 'ref.png');
    await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [image] });
    const upload = vi
      .spyOn(MediaApiClient.prototype, 'uploadFile')
      .mockResolvedValue({ id: 'file-1' } as Awaited<ReturnType<MediaApiClient['uploadFile']>>);
    cleanup.push(async () => upload.mockRestore());
    expect(await invoke(IPC_CHANNELS.studioUploadReference, draft.sessionId)).toEqual({
      fileId: 'file-1',
      name: 'ref.png',
    });
    expect(upload).toHaveBeenCalledWith('ref.png', 'image/png', expect.any(Buffer));
  });

  it('prepares and creates once, then refuses both review and authorization replay', async () => {
    const { integration, invoke, draft, paid, prepareText, api } = await setup();
    const submit = vi.spyOn(integration.generation, 'submit');
    const review = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    const request = { draft, reviewId: review.id, preparedPrompt: review.preparedPrompt };
    await invoke(IPC_CHANNELS.studioCreate, request);
    expect(paid).toHaveBeenCalledTimes(1);
    const [sessionId, body, authorize] = submit.mock.calls[0];
    expect(await authorize?.({ sessionId, request: body })).toBe(false);
    await expect(invoke(IPC_CHANNELS.studioCreate, request)).rejects.toThrow('Review expired');
    expect(paid).toHaveBeenCalledTimes(1);
    expect(prepareText.mock.calls[0]?.[4]).toBe(api);
  });
  it('refuses an authorization presented for a different parsed body', async () => {
    const { integration, invoke, draft, paid } = await setup();
    const original = integration.generation.submit.bind(integration.generation);
    vi.spyOn(integration.generation, 'submit').mockImplementationOnce(async (sessionId, input, authorize) => {
      if (input.kind !== 'image') throw new Error('Expected an image fixture');
      expect(await authorize?.({ sessionId, request: { ...input, count: 4 } })).toBe(false);
      return original(sessionId, input, authorize);
    });
    const review = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    await expect(
      invoke(IPC_CHANNELS.studioCreate, { draft, reviewId: review.id, preparedPrompt: review.preparedPrompt })
    ).rejects.toThrow('not approved');
    expect(paid).not.toHaveBeenCalled();
  });
  it('binds reviewed context selection into the single-use generation authorization', async () => {
    const { integration, invoke, draft, paid } = await setup();
    const original = integration.generation.submit.bind(integration.generation);
    vi.spyOn(integration.generation, 'submit').mockImplementationOnce(async (sessionId, input, authorize) => {
      expect(input.selection).toEqual({ mode: 'none' });
      expect(await authorize?.({ sessionId, request: { ...input, selection: { mode: 'current-session' } } })).toBe(
        false
      );
      return original(sessionId, input, authorize);
    });
    const review = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    await expect(
      invoke(IPC_CHANNELS.studioCreate, { draft, reviewId: review.id, preparedPrompt: review.preparedPrompt })
    ).rejects.toThrow('not approved');
    expect(paid).not.toHaveBeenCalled();
  });
  it('rejects a prepared request after an account switch without a paid POST', async () => {
    const { invoke, draft, paid, switchAccount } = await setup();
    const review = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    switchAccount();
    await expect(
      invoke(IPC_CHANNELS.studioCreate, { draft, reviewId: review.id, preparedPrompt: review.preparedPrompt })
    ).rejects.toThrow();
    expect(paid).not.toHaveBeenCalled();
  });
  it('keeps separate approvals for identical concurrent requests', async () => {
    const { invoke, draft, paid } = await setup();
    const first = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    const second = (await invoke(IPC_CHANNELS.studioPrepare, draft)) as StudioReview;
    await Promise.all(
      [first, second].map(review =>
        invoke(IPC_CHANNELS.studioCreate, { draft, reviewId: review.id, preparedPrompt: review.preparedPrompt })
      )
    );
    expect(paid).toHaveBeenCalledTimes(2);
  });
});
