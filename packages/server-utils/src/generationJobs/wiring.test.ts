import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_IMAGE_MODELS,
  IMAGE_MODEL_CATALOG,
  StorageLimitError,
  type IGenerationJobDocument,
  type ImageProviderId,
  type ModerationLabelHit,
  type MusicProviderId,
  type StorageLimitErrorInfo,
  type VideoProviderId,
} from '@bike4mind/common';

const { queueLink, getSourceQueueUrl, sendToQueue, userFindById, checkStorageLimit, getSettingsMap } = vi.hoisted(
  () => ({
    queueLink: { mode: 'direct' as 'direct' | 'throws' },
    getSourceQueueUrl: vi.fn(),
    sendToQueue: vi.fn(),
    userFindById: vi.fn(),
    checkStorageLimit: vi.fn(),
    getSettingsMap: vi.fn(),
  })
);

const notifications = vi.hoisted(() => ({
  sendToClient: vi.fn(),
  deliverToSlack: vi.fn(),
  slackDeps: { marker: 'slack-delivery-deps' },
  notify: undefined as ((job: IGenerationJobDocument) => Promise<void>) | undefined,
  handlers: [] as { kind: string }[],
}));

const { moderateImageOrThrow, usageEventRecord } = vi.hoisted(() => ({
  moderateImageOrThrow: vi.fn(),
  usageEventRecord: vi.fn(),
}));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow }));

vi.mock('@bike4mind/services/generationJobs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/generationJobs')>()),
  GenerationJobEngine: class {
    constructor(deps: { notify(job: IGenerationJobDocument): Promise<void>; handlers: { kind: string }[] }) {
      notifications.notify = deps.notify;
      notifications.handlers = deps.handlers;
    }
  },
}));
vi.mock('./slackJobDelivery', () => ({
  deliverJobToSlack: notifications.deliverToSlack,
  imageGroupSlackSubscriber: vi.fn(() => ({ name: 'slack', wants: () => false, deliver: async () => {} })),
}));
vi.mock('./imageGroupPush', () => ({
  imageGroupPushSubscriber: vi.fn(() => ({ name: 'push', wants: () => false, deliver: async () => {} })),
}));
vi.mock('../utils/pushNotifications', () => ({
  appPathDeepLink: (path: string) => path,
  appRootDeepLink: () => '/',
  publishPushNotification: vi.fn(async () => undefined),
}));
vi.mock('./slackJobDeliveryDeps', () => ({ createSlackJobDeliveryDeps: () => notifications.slackDeps }));

// A getter mirrors sst's Resource proxy, which throws when a key is not linked to the Lambda.
vi.mock('sst', () => ({
  Resource: {
    websocket: { managementEndpoint: 'https://ws.example.test' },
    get generationJobQueue(): { url: string } {
      if (queueLink.mode === 'throws') throw new Error('generationJobQueue is not linked');
      return { url: 'https://sqs.example.test/direct' };
    },
  },
}));
vi.mock('../utils/dlqRegistry', () => ({ getSourceQueueUrl }));
vi.mock('../utils/storage/index', () => ({
  getFilesStorage: vi.fn(),
  getGeneratedImageStorage: vi.fn(),
}));
// No stored keys needed: a database round trip here would only slow the test down.
vi.mock('@bike4mind/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/auth')>();
  return {
    ...actual,
    apiKeyService: {
      ...actual.apiKeyService,
      getEffectiveLLMApiKeys: vi.fn(async () => ({})),
      getEffectiveApiKey: vi.fn(async () => 'e-key'),
    },
  };
});
vi.mock('../utils/sqs', () => ({ sendToQueue }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return {
    ...actual,
    userRepository: { ...actual.userRepository, findById: userFindById },
    usageEventRepository: { ...actual.usageEventRepository, record: usageEventRecord },
  };
});
vi.mock('@bike4mind/utils/imageModeration', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils/imageModeration')>()),
  RekognitionImageModerationService: class {},
}));
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    checkStorageLimit,
    getSettingsMap,
    ClientMessageSender: class {
      sendToClient = notifications.sendToClient;
    },
  };
});

import { adminSettingsRepository } from '@bike4mind/database';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import { createImageProviderRegistry } from '@bike4mind/utils/imageProviders';
import { createMusicProviderRegistry } from '@bike4mind/utils/musicProviders';
import { createVideoProviderRegistry } from '@bike4mind/utils/videoProviders';
import {
  buildImageProviders,
  buildMusicProviders,
  buildProviders,
  checkStorageFor,
  enqueueGenerationJob,
  getGenerationJobEngine,
  getMusicJobDeps,
  getVideoJobDeps,
  moderateImage,
  recordImageUsage,
  selectImageProviderKey,
  selectMusicProviderKey,
  selectProviderKey,
  toJobUpdate,
  usableApiKey,
} from './wiring';

const baseJob = {
  id: 'job1',
  kind: 'video',
  state: 'running',
  requestedBy: 'user1',
  creditHold: { reservedCredits: 10 },
  rawProviderError: { secret: 'internal' },
  payload: { providerId: 'test', request: { model: 'm' } },
} as unknown as IGenerationJobDocument;

describe('generation job notification wiring', () => {
  beforeEach(() => {
    notifications.sendToClient.mockReset().mockResolvedValue(undefined);
    notifications.deliverToSlack.mockReset().mockResolvedValue(undefined);
    getGenerationJobEngine();
  });

  const notify = (job: IGenerationJobDocument) => {
    if (!notifications.notify) throw new Error('GenerationJobEngine notification callback was not wired');
    return notifications.notify(job);
  };

  it('sends the job update and the original job to their respective channels', async () => {
    await expect(notify(baseJob)).resolves.toBeUndefined();
    expect(notifications.sendToClient).toHaveBeenCalledWith(
      baseJob.requestedBy,
      'https://ws.example.test',
      toJobUpdate(baseJob)
    );
    expect(notifications.deliverToSlack.mock.calls[0][0]).toBe(baseJob);
    expect(notifications.deliverToSlack.mock.calls[0][1]).toBe(notifications.slackDeps);
  });

  it('still delivers to Slack when the websocket update fails', async () => {
    const error = new Error('websocket unavailable');
    notifications.sendToClient.mockRejectedValue(error);
    await expect(notify(baseJob)).rejects.toBe(error);
    expect(notifications.deliverToSlack).toHaveBeenCalledWith(baseJob, notifications.slackDeps);
  });

  it('still sends the websocket update when Slack delivery fails', async () => {
    const error = new Error('Slack unavailable');
    notifications.deliverToSlack.mockRejectedValue(error);
    await expect(notify(baseJob)).rejects.toBe(error);
    expect(notifications.sendToClient).toHaveBeenCalledWith(
      baseJob.requestedBy,
      'https://ws.example.test',
      toJobUpdate(baseJob)
    );
  });
});

describe('usableApiKey', () => {
  it('returns a real key unchanged', () => {
    expect(usableApiKey('sk-live')).toBe('sk-live');
  });

  it.each([null, undefined, ''])('maps a missing or empty key (%j) to null', raw => {
    expect(usableApiKey(raw)).toBeNull();
  });

  it('maps the expired sentinel to null so it never reaches a provider call', () => {
    expect(usableApiKey('expired')).toBeNull();
  });

  it.each(['your-api-key', 'REPLACE_ME', 'not-configured', '   '])(
    'maps a placeholder (%j) to null, as model discovery does',
    raw => {
      expect(usableApiKey(raw)).toBeNull();
    }
  );
});

describe('provider key selection', () => {
  it('gives the test provider a fixed key without consulting stored keys', () => {
    expect(selectProviderKey('test', {} as never)).toBe('test-key');
  });

  it('maps gemini-omni to the Gemini key', () => {
    expect(selectProviderKey('gemini-omni', { gemini: 'g-key' } as never)).toBe('g-key');
    expect(usableApiKey(selectProviderKey('gemini-omni', { gemini: null } as never))).toBeNull();
  });

  it('maps veo to the same Gemini key as gemini-omni', () => {
    expect(selectProviderKey('veo', { gemini: 'g-key' } as never)).toBe('g-key');
    expect(usableApiKey(selectProviderKey('veo', { gemini: null } as never))).toBeNull();
    expect(usableApiKey(selectProviderKey('veo', { gemini: 'your-api-key' } as never))).toBeNull();
  });

  it('maps xai to the xAI chat key, so placeholder and expiry checks apply unchanged', () => {
    expect(selectProviderKey('xai', { xai: 'x-key' } as never)).toBe('x-key');
    expect(usableApiKey(selectProviderKey('xai', { xai: null } as never))).toBeNull();
    expect(usableApiKey(selectProviderKey('xai', { xai: 'your-api-key' } as never))).toBeNull();
    expect(usableApiKey(selectProviderKey('xai', { xai: 'expired' } as never))).toBeNull();
  });

  it('maps bfl to the BFL key and applies placeholder checks', () => {
    expect(selectProviderKey('bfl', { bfl: 'b-key' } as never)).toBe('b-key');
    expect(usableApiKey(selectProviderKey('bfl', { bfl: null } as never))).toBeNull();
    expect(usableApiKey(selectProviderKey('bfl', { bfl: 'your-api-key' } as never))).toBeNull();
  });

  it('throws for a provider id with no mapping', () => {
    expect(() => selectProviderKey('unmapped' as VideoProviderId, {} as never)).toThrow(/no API key mapping/);
  });

  it('resolves the test provider key through the deps', async () => {
    const apiKey = await getVideoJobDeps().resolveApiKey('test', 'user1');
    expect(apiKey).toBe('test-key');
  });
});

describe('music provider key selection', () => {
  it('gives the test provider a fixed key', () => {
    expect(selectMusicProviderKey('test', {} as never)).toBe('test-key');
  });

  it('maps gemini-lyria to the Gemini key, so placeholder and expiry checks apply unchanged', () => {
    expect(selectMusicProviderKey('gemini-lyria', { gemini: 'g-key' } as never)).toBe('g-key');
    expect(usableApiKey(selectMusicProviderKey('gemini-lyria', { gemini: null } as never))).toBeNull();
    expect(usableApiKey(selectMusicProviderKey('gemini-lyria', { gemini: 'expired' } as never))).toBeNull();
  });

  it('maps elevenlabs to the ElevenLabs key, never the Gemini one', () => {
    expect(selectMusicProviderKey('elevenlabs', { gemini: 'g-key', elevenlabs: 'e-key' } as never)).toBe('e-key');
    expect(usableApiKey(selectMusicProviderKey('elevenlabs', { gemini: 'g-key' } as never))).toBeNull();
  });

  it('throws for a provider id with no mapping', () => {
    expect(() => selectMusicProviderKey('unmapped' as MusicProviderId, {} as never)).toThrow(/no API key mapping/);
  });

  it('resolves the test provider key through the deps', async () => {
    expect(await getMusicJobDeps().resolveApiKey('test', 'user1')).toBe('test-key');
  });

  it('resolves the ElevenLabs key through the deps', async () => {
    expect(await getMusicJobDeps().resolveApiKey('elevenlabs', 'user1')).toBe('e-key');
  });
});

describe('image provider key selection', () => {
  const keys = { openai: 'o-key', gemini: 'g-key', xai: 'x-key', bfl: 'b-key', imageGen: 'http://sd.local' } as never;

  it('maps each provider to the key the chat image paths use', () => {
    expect(selectImageProviderKey('openai', keys)).toBe('o-key');
    expect(selectImageProviderKey('gemini', keys)).toBe('g-key');
    expect(selectImageProviderKey('bfl', keys)).toBe('b-key');
    expect(selectImageProviderKey('xai', keys)).toBe('x-key');
    expect(usableApiKey(selectImageProviderKey('openai', { openai: 'expired' } as never))).toBeNull();
  });

  it('gives the test provider a fixed key without consulting stored keys', () => {
    expect(selectImageProviderKey('test', {} as never)).toBe('test-key');
  });

  it('maps local to the self-hosted image server URL, and to nothing when it is unset', () => {
    expect(selectImageProviderKey('local', keys)).toBe('http://sd.local');
    expect(selectImageProviderKey('local', {} as never)).toBeUndefined();
  });

  it('throws for a provider id with no mapping', () => {
    expect(() => selectImageProviderKey('unmapped' as ImageProviderId, keys)).toThrow(/no API key mapping/);
  });
});

describe('buildImageProviders', () => {
  // createImageJobs refuses a model whose provider is not registered (model_unavailable).
  it.each(['bfl', 'xai'] as const)('serves every %s catalog model', providerId => {
    const registry = createImageProviderRegistry(buildImageProviders());
    const models = ALL_IMAGE_MODELS.filter(model => IMAGE_MODEL_CATALOG[model].provider === providerId);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(registry.get(providerId)?.models).toContain(model);
  });
});

describe('checkStorageFor', () => {
  const info: StorageLimitErrorInfo = {
    errorCode: 'storage_limit_exceeded',
    used_bytes: 900,
    limit_bytes: 1_000,
    requested_bytes: 2_000,
    owner: 'user',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    userFindById.mockResolvedValue({ id: 'u1' });
  });

  it('answers undefined when the quota has room', async () => {
    checkStorageLimit.mockResolvedValue(undefined);
    await expect(checkStorageFor('u1', 2_000)).resolves.toBeUndefined();
    expect(userFindById).toHaveBeenCalledWith('u1');
    expect(checkStorageLimit).toHaveBeenCalledWith({ id: 'u1' }, 2_000);
  });

  it('returns the quota detail for a storage refusal', async () => {
    checkStorageLimit.mockRejectedValue(new StorageLimitError('full', info));
    await expect(checkStorageFor('u1', 2_000)).resolves.toEqual(info);
  });

  it('rethrows any other failure rather than reporting room', async () => {
    checkStorageLimit.mockRejectedValue(new Error('db down'));
    await expect(checkStorageFor('u1', 2_000)).rejects.toThrow('db down');
  });

  it('throws for a missing user', async () => {
    userFindById.mockResolvedValue(null);
    await expect(checkStorageFor('u1', 2_000)).rejects.toThrow('user u1 not found');
    expect(checkStorageLimit).not.toHaveBeenCalled();
  });
});

describe('toJobUpdate', () => {
  it('never exposes internal fields', () => {
    const update = toJobUpdate(baseJob);
    expect(update).toEqual({
      action: 'generation_job_updated',
      job: { id: 'job1', kind: 'video', state: 'running' },
    });
    expect(JSON.stringify(update)).not.toContain('secret');
    expect(JSON.stringify(update)).not.toContain('creditHold');
  });

  it('includes output.fileId only when present', () => {
    const withFile = toJobUpdate({
      ...baseJob,
      state: 'succeeded',
      payload: { ...baseJob.payload, output: { contentType: 'video/mp4', durationSeconds: 4, fileId: 'f1' } },
    } as IGenerationJobDocument);
    expect(withFile.job.output).toEqual({ fileId: 'f1', contentType: 'video/mp4', durationSeconds: 4 });

    const withoutFile = toJobUpdate({
      ...baseJob,
      state: 'succeeded',
      payload: { ...baseJob.payload, output: { contentType: 'video/mp4', durationSeconds: 4 } },
    } as IGenerationJobDocument);
    expect(withoutFile.job.output).toEqual({ contentType: 'video/mp4', durationSeconds: 4 });
  });

  it('maps an image job output, which has no duration', () => {
    const update = toJobUpdate({
      ...baseJob,
      kind: 'image',
      state: 'succeeded',
      payload: {
        providerId: 'openai',
        request: { model: 'gpt-image-1', mode: 'generate', prompt: 'p' },
        output: { location: 'files', s3Key: 'k', contentType: 'image/png', bytes: 3, fileId: 'f1' },
      },
    } as IGenerationJobDocument);
    expect(update.job.output).toEqual({ fileId: 'f1', contentType: 'image/png' });
  });

  it('maps a music job output without its lyrics', () => {
    const update = toJobUpdate({
      ...baseJob,
      kind: 'music',
      state: 'succeeded',
      payload: {
        providerId: 'test',
        request: { model: 'test-music' },
        output: { contentType: 'audio/mpeg', durationSeconds: 5, fileId: 'f1', lyrics: 'la la' },
      },
    } as IGenerationJobDocument);
    expect(update.job).toMatchObject({ kind: 'music', output: { fileId: 'f1', contentType: 'audio/mpeg' } });
    expect(JSON.stringify(update)).not.toContain('la la');
  });

  it('carries progress and the error code and message', () => {
    const update = toJobUpdate({
      ...baseJob,
      state: 'failed',
      progress: 0.5,
      error: { code: 'provider_error', message: 'boom' },
    } as IGenerationJobDocument);
    expect(update.job).toMatchObject({ progress: 0.5, error: { code: 'provider_error', message: 'boom' } });
  });
});

describe('enqueueGenerationJob queue URL resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueLink.mode = 'direct';
    getSourceQueueUrl.mockReturnValue('https://sqs.example.test/registry');
  });

  it('prefers the directly linked queue and passes the delay through unchanged', async () => {
    await enqueueGenerationJob('job1', 30);
    expect(sendToQueue).toHaveBeenCalledWith('https://sqs.example.test/direct', { jobId: 'job1' }, 30);
    expect(getSourceQueueUrl).not.toHaveBeenCalled();
  });

  it('falls back to the sourceQueueUrls registry when the queue is not linked directly', async () => {
    queueLink.mode = 'throws';
    await enqueueGenerationJob('job2', 0);
    expect(sendToQueue).toHaveBeenCalledWith('https://sqs.example.test/registry', { jobId: 'job2' }, 0);
  });

  it('rejects loudly, without sending, when neither source resolves a URL', async () => {
    queueLink.mode = 'throws';
    getSourceQueueUrl.mockImplementation(() => {
      throw new Error('Missing source queue URL for: generationJobQueue.');
    });
    await expect(enqueueGenerationJob('job3', 5)).rejects.toThrow('Missing source queue URL');
    expect(sendToQueue).not.toHaveBeenCalled();
  });
});

describe('buildProviders', () => {
  afterEach(() => {
    delete process.env.ENABLE_TEST_VIDEO_PROVIDER;
  });

  it('registers Gemini Omni, xAI, Veo and BFL unconditionally, Gemini first', () => {
    expect(buildProviders().map(provider => provider.id)).toEqual(['gemini-omni', 'xai', 'veo', 'bfl']);
  });

  it('adds the test provider only when enabled', () => {
    process.env.ENABLE_TEST_VIDEO_PROVIDER = 'true';
    expect(buildProviders().map(provider => provider.id)).toEqual(['gemini-omni', 'xai', 'veo', 'bfl', 'test']);
  });

  it('builds a registry the catalog-owner check accepts', () => {
    process.env.ENABLE_TEST_VIDEO_PROVIDER = 'true';
    expect(() => createVideoProviderRegistry(buildProviders())).not.toThrow();
  });
});

describe('buildImageProviders', () => {
  afterEach(() => {
    delete process.env.ENABLE_TEST_IMAGE_PROVIDER;
  });

  it('registers the OpenAI, Gemini, BFL, xAI and local adapters, which the catalog accepts', () => {
    expect(buildImageProviders().map(provider => provider.id)).toEqual(['openai', 'gemini', 'bfl', 'xai', 'local']);
    expect(() => createImageProviderRegistry(buildImageProviders())).not.toThrow();
  });

  it('adds the test provider only when enabled', () => {
    process.env.ENABLE_TEST_IMAGE_PROVIDER = 'true';
    expect(buildImageProviders().map(provider => provider.id)).toEqual([
      'openai',
      'gemini',
      'bfl',
      'xai',
      'local',
      'test',
    ]);
    expect(() => createImageProviderRegistry(buildImageProviders())).not.toThrow();
  });

  it('does not add the test provider for any other value of the flag', () => {
    process.env.ENABLE_TEST_IMAGE_PROVIDER = '1';
    expect(buildImageProviders().map(provider => provider.id)).not.toContain('test');
  });
});

describe('buildMusicProviders', () => {
  afterEach(() => {
    delete process.env.ENABLE_TEST_MUSIC_PROVIDER;
  });

  it('registers Lyria and ElevenLabs unconditionally', () => {
    expect(buildMusicProviders().map(provider => provider.id)).toEqual(['gemini-lyria', 'elevenlabs']);
  });

  it('adds the test provider only when enabled', () => {
    process.env.ENABLE_TEST_MUSIC_PROVIDER = 'true';
    expect(buildMusicProviders().map(provider => provider.id)).toEqual(['gemini-lyria', 'elevenlabs', 'test']);
  });

  it('builds a registry the catalog-owner check accepts', () => {
    process.env.ENABLE_TEST_MUSIC_PROVIDER = 'true';
    expect(() => createMusicProviderRegistry(buildMusicProviders())).not.toThrow();
  });
});

describe('generation job billing settings', () => {
  beforeEach(() => {
    getSettingsMap.mockReset();
    // A stored enforceCredits=false only reads as off on self-host; hosted always meters.
    vi.stubEnv('B4M_SELF_HOST', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { kind: 'video', settingName: 'videoGeneration', model: 'veo-3', getDeps: getVideoJobDeps },
    { kind: 'music', settingName: 'musicGeneration', model: 'lyria-002', getDeps: getMusicJobDeps },
  ] as const)('reads fresh enforcement and model switches for $kind jobs', async ({ settingName, model, getDeps }) => {
    const modelSettings = { enabledModels: { [model]: false } };
    getSettingsMap.mockResolvedValue({ enforceCredits: 'false', [settingName]: JSON.stringify(modelSettings) });

    const settings = await getDeps().getSettings();

    expect(getSettingsMap).toHaveBeenCalledExactlyOnceWith(
      { adminSettings: adminSettingsRepository },
      { names: ['enforceCredits', settingName], skipCache: true }
    );
    expect(settings).toEqual({ enforceCredits: false, [settingName]: modelSettings });
  });
});

describe('image job engine registration', () => {
  it('registers a handler for the image kind next to video and music', () => {
    getGenerationJobEngine();
    expect(notifications.handlers.map(handler => handler.kind)).toEqual(
      expect.arrayContaining(['video', 'music', 'image'])
    );
  });
});

describe('image job moderation', () => {
  const imageJob = (mode: 'generate' | 'edit') =>
    ({
      id: 'job1',
      kind: 'image',
      requestedBy: 'user1',
      questId: 'quest1',
      payload: { providerId: 'openai', request: { model: 'gpt-image-2', mode, prompt: 'x' } },
    }) as unknown as Parameters<typeof moderateImage>[0]['job'];
  const scan = (mode: 'generate' | 'edit' = 'generate') =>
    moderateImage({ job: imageJob(mode), bytes: Buffer.from('img'), mimeType: 'image/png' });

  beforeEach(() => {
    moderateImageOrThrow.mockReset().mockResolvedValue(undefined);
    getSettingsMap.mockReset().mockResolvedValue({});
  });

  it('passes an image the gate accepts', async () => {
    await expect(scan()).resolves.toEqual({ blocked: false });
  });

  it('turns a confirmed block into a verdict carrying the reason', async () => {
    const blocked = new ImageModerationBlockedError([{ name: 'Violence', confidence: 99.5 }] as ModerationLabelHit[]);
    moderateImageOrThrow.mockRejectedValue(blocked);
    await expect(scan()).resolves.toEqual({ blocked: true, reason: blocked.message });
  });

  it('propagates any other error so an unscanned image is not kept', async () => {
    const failure = new Error('rekognition unavailable');
    moderateImageOrThrow.mockRejectedValue(failure);
    await expect(scan()).rejects.toBe(failure);
  });

  it('enables the gate when ImageModerationEnabled is unset', async () => {
    await scan();
    expect(moderateImageOrThrow).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it.each([
    ['edit', 'edit'],
    ['generate', 'generation'],
  ] as const)('reports a %s job to the incident store as the %s surface', async (mode, surface) => {
    await scan(mode);
    expect(moderateImageOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        incidentMeta: expect.objectContaining({
          userId: 'user1',
          questId: 'quest1',
          provider: 'openai',
          model: 'gpt-image-2',
          surface,
        }),
      })
    );
  });
});

describe('image usage recording', () => {
  const usage = (mode: 'generate' | 'edit') =>
    recordImageUsage({
      job: {
        id: 'job1',
        requestedBy: 'user1',
        ownerId: 'owner1',
        ownerType: 'user',
        payload: { providerId: 'openai', request: { model: 'gpt-image-2', mode, prompt: 'x' } },
      } as unknown as Parameters<typeof recordImageUsage>[0]['job'],
      creditsCharged: 5,
      costUsd: 0.05,
      status: 'refusal',
    } as unknown as Parameters<typeof recordImageUsage>[0]);

  beforeEach(() => {
    usageEventRecord.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['edit', 'image_edit'],
    ['generate', 'image_generation'],
  ] as const)('records a %s job under the %s feature as one unit', async (mode, feature) => {
    await usage(mode);
    expect(usageEventRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: 'job1',
        userId: 'user1',
        ownerId: 'owner1',
        feature,
        provider: 'openai',
        model: 'gpt-image-2',
        units: 1,
        costUsd: 0.05,
        creditsCharged: 5,
        status: 'refusal',
      })
    );
  });

  it('never fails the job when the analytics row cannot be written', async () => {
    usageEventRecord.mockRejectedValue(new Error('mongo down'));
    await expect(usage('generate')).resolves.toBeUndefined();
  });
});
