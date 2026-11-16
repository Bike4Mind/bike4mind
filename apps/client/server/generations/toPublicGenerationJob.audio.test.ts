import { describe, expect, it } from 'vitest';
import {
  AUDIO_JOB_PUBLIC_ERROR_CODES,
  CreditHolderType,
  GENERATION_JOB_ERROR_CODES,
  SoundEffectGenerationSchema,
  SpeechGenerationSchema,
  type IGenerationJobDocumentOf,
} from '@bike4mind/common';
import type { JobMapperDeps } from '@bike4mind/server-utils/generations/signedOutput';
import {
  SOUND_EFFECT_GENERATION_PROJECTION,
  SPEECH_GENERATION_PROJECTION,
  toPublicGenerationJob,
} from './toPublicGenerationJob';

const base = {
  id: '664f1c2b9a1e4d0012ab34cd',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'api' as const,
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-10-06T00:20:00Z'),
  creditHold: null,
  createdAt: new Date('2026-10-06T00:00:00Z'),
  updatedAt: new Date('2026-10-06T00:01:00Z'),
};

const output = {
  location: 'files' as const,
  s3Key: 'files/clip.mp3',
  fileId: 'f1',
  contentType: 'audio/mpeg',
  bytes: 10,
};

const speechJob = (overrides: Partial<IGenerationJobDocumentOf<'speech'>> = {}) =>
  ({
    ...base,
    kind: 'speech',
    state: 'running',
    payload: { request: { text: 'hello', provider: 'openai' }, candidates: ['openai'], saveToFiles: true },
    ...overrides,
  }) as IGenerationJobDocumentOf<'speech'>;

const soundJob = (overrides: Partial<IGenerationJobDocumentOf<'sound_effect'>> = {}) =>
  ({
    ...base,
    kind: 'sound_effect',
    state: 'running',
    payload: {
      request: { text: 'door creak', provider: 'elevenlabs', durationSeconds: 3 },
      providerId: 'elevenlabs',
      saveToFiles: true,
    },
    ...overrides,
  }) as IGenerationJobDocumentOf<'sound_effect'>;

const deps: JobMapperDeps = {
  sign: async () => ({ availability: 'ready', url: 'https://signed.example/out' }),
  now: () => new Date('2026-10-06T00:02:00Z'),
};

describe('toPublicGenerationJob (speech and sound effects)', () => {
  it('renders an in-flight speech job in the published key order', async () => {
    const body = await toPublicGenerationJob(speechJob(), deps, SPEECH_GENERATION_PROJECTION);
    expect(Object.keys(body)).toEqual(Object.keys(SpeechGenerationSchema.shape));
    expect(SpeechGenerationSchema.parse(body)).toMatchObject({
      object: 'speech_generation',
      state: 'running',
      text: 'hello',
      provider: 'openai',
      model: null,
      voice: null,
      output: null,
      credits: { reserved: null, settled: null },
    });
  });

  it('renders a succeeded sound effect with its signed output', async () => {
    const job = soundJob({
      state: 'succeeded',
      payload: { ...soundJob().payload, output: { ...output, durationSeconds: 3 } },
    });
    const body = await toPublicGenerationJob(job, deps, SOUND_EFFECT_GENERATION_PROJECTION);
    expect(Object.keys(body)).toEqual(Object.keys(SoundEffectGenerationSchema.shape));
    expect(SoundEffectGenerationSchema.parse(body)).toMatchObject({
      object: 'sound_effect_generation',
      duration_seconds: 3,
      output: { availability: 'ready', duration_seconds: 3, file_id: 'f1' },
    });
  });

  it('reports an unmeasured clip length as null', async () => {
    const job = speechJob({ state: 'succeeded', payload: { ...speechJob().payload, output } });
    const body = await toPublicGenerationJob(job, deps, SPEECH_GENERATION_PROJECTION);
    expect(body.output?.duration_seconds).toBeNull();
  });

  it.each(GENERATION_JOB_ERROR_CODES)('folds %s into a published code with fixed copy', async code => {
    const failed = speechJob({ state: 'failed', error: { code, message: 'provider wording' } });
    const body = SpeechGenerationSchema.parse(await toPublicGenerationJob(failed, deps, SPEECH_GENERATION_PROJECTION));
    expect(AUDIO_JOB_PUBLIC_ERROR_CODES).toContain(body.error?.code);
    expect(body.error?.message).not.toContain('provider wording');
  });
});
