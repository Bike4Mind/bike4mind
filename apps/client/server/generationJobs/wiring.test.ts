import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StorageLimitError,
  type IGenerationJobDocument,
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
}));

vi.mock('@bike4mind/services/generationJobs', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/generationJobs')>()),
  GenerationJobEngine: class {
    constructor(deps: { notify(job: IGenerationJobDocument): Promise<void> }) {
      notifications.notify = deps.notify;
    }
  },
}));
vi.mock('./slackJobDelivery', () => ({ deliverJobToSlack: notifications.deliverToSlack }));
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
vi.mock('@bike4mind/server-utils/utils/dlqRegistry', () => ({ getSourceQueueUrl }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
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
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue }));
vi.mock('@bike4mind/database', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/database')>();
  return { ...actual, userRepository: { ...actual.userRepository, findById: userFindById } };
});
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
import { createMusicProviderRegistry } from '@bike4mind/utils/musicProviders';
import { createVideoProviderRegistry } from '@bike4mind/utils/videoProviders';
import {
  buildMusicProviders,
  buildProviders,
  checkStorageFor,
  enqueueGenerationJob,
  getGenerationJobEngine,
  getMusicJobDeps,
  getVideoJobDeps,
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

  it('registers Gemini Omni, xAI and Veo unconditionally, Gemini first', () => {
    expect(buildProviders().map(provider => provider.id)).toEqual(['gemini-omni', 'xai', 'veo']);
  });

  it('adds the test provider only when enabled', () => {
    process.env.ENABLE_TEST_VIDEO_PROVIDER = 'true';
    expect(buildProviders().map(provider => provider.id)).toEqual(['gemini-omni', 'xai', 'veo', 'test']);
  });

  it('builds a registry the catalog-owner check accepts', () => {
    process.env.ENABLE_TEST_VIDEO_PROVIDER = 'true';
    expect(() => createVideoProviderRegistry(buildProviders())).not.toThrow();
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
