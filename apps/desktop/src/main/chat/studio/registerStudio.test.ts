import { mkdtemp, rm } from 'node:fs/promises';
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
import { MediaStore } from '../media/MediaStore';
import { registerStudio } from './registerStudio';

vi.mock('electron', () => ({ app: { once: vi.fn() }, dialog: {}, shell: {} }));
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
      case '/api/studio/image-jobs?limit=1':
        data = { data: [] };
        break;
      case '/api/studio/image-jobs': {
        paid(config);
        data = { groupId: 'group', jobs: [{ id: 'remote', state: 'queued', output: null, error: null }] };
        break;
      }
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

describe('registered Studio authorization', () => {
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
