import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { VideoModel } from '@bike4mind/common';
import type { ChatModelOption } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { publicVideoModel } from './media/__fixtures__/videoModels';
import type { MediaStore } from './media/MediaStore';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const HOSTED = 'claude-opus-4-5-20251101';
const NO_TOOLS = 'plain-text-model';

const CATALOG: ChatModelOption[] = [
  { id: HOSTED, name: 'Claude 4.5 Opus', backend: 'anthropic' },
  { id: NO_TOOLS, name: 'Plain', backend: 'openai', supportsTools: false },
];

/** The blank chat's cards must match what runTurn would declare; see toolsForRequest. */
describe('ChatService.listCreationTools', () => {
  let signedIn: boolean;
  let video: VideoModel[];
  let listVideoModels: ReturnType<typeof vi.fn>;

  async function service(media = true): Promise<ChatService> {
    return new ChatService({
      store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-creation-tools-')), HOSTED),
      access: { list: async () => [] } as unknown as AccessStore,
      models: {
        list: async () => ({ models: CATALOG }),
        cached: () => CATALOG,
        listVideoModels,
      } as unknown as ModelCatalog,
      ...(media ? { media: {} as MediaStore } : {}),
      preferredModel: HOSTED,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () => (signedIn ? ({} as AuthenticatedApiClient) : null),
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: () => {},
      summaryChanged: () => {},
    });
  }

  const names = async (chat: ChatService, model: string) =>
    (await chat.listCreationTools(model)).map(tool => tool.name);

  beforeEach(() => {
    signedIn = true;
    video = [publicVideoModel('gemini-omni-1.1-flash')];
    listVideoModels = vi.fn(async () => video);
  });

  it('offers every generation tool to a hosted model when the server has video', async () => {
    expect(await names(await service(), HOSTED)).toEqual([
      'generate_image',
      'generate_speech',
      'generate_sound_effect',
      'generate_music',
      'generate_video',
    ]);
  });

  it('drops video when the server offers no video model', async () => {
    video = [];
    expect(await names(await service(), HOSTED)).not.toContain('generate_video');
  });

  it('offers nothing to a local model, without asking the server', async () => {
    expect(await names(await service(), 'local:ollama:qwen3:8b')).toEqual([]);
    expect(listVideoModels).not.toHaveBeenCalled();
  });

  it('offers nothing to a model that takes no tools', async () => {
    expect(await names(await service(), NO_TOOLS)).toEqual([]);
  });

  it('offers nothing signed out or without a media store', async () => {
    expect(await names(await service(false), HOSTED)).toEqual([]);
    signedIn = false;
    expect(await names(await service(), HOSTED)).toEqual([]);
  });
});
