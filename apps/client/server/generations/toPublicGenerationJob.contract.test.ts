import { describe, expect, it } from 'vitest';
import {
  CreditHolderType,
  GENERATION_JOB_ERROR_CODES,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type MusicGeneration,
  type VideoGeneration,
} from '@bike4mind/common';
import type { JobMapperDeps, SignedOutput } from '@bike4mind/server-utils/generations/signedOutput';
import {
  MUSIC_GENERATION_PROJECTION,
  toPublicGenerationJob,
  VIDEO_GENERATION_PROJECTION,
} from './toPublicGenerationJob';

const toPublicVideoGeneration = (job: IGenerationJobDocumentOf<'video'>, deps: JobMapperDeps): Promise<VideoGeneration> =>
  toPublicGenerationJob(job, deps, VIDEO_GENERATION_PROJECTION);
const toPublicMusicGeneration = (job: IGenerationJobDocumentOf<'music'>, deps: JobMapperDeps): Promise<MusicGeneration> =>
  toPublicGenerationJob(job, deps, MUSIC_GENERATION_PROJECTION);

// Byte-level pins for the public v1 video and music resources. A string snapshot (not an object one, which sorts
// keys) also pins key order, so a projection change that reorders or renames a field fails here.

const base = {
  id: '664f1c2b9a1e4d0012ab34cd',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'api' as const,
  pollCount: 1,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-10-06T00:20:00Z'),
  creditHold: {
    ownerId: 'u1',
    ownerType: CreditHolderType.User,
    userId: 'u1',
    organizationId: null,
    reservedCredits: 120,
    balanceAfterHold: 100,
  },
  createdAt: new Date('2026-10-06T00:00:00Z'),
  updatedAt: new Date('2026-10-06T00:01:00Z'),
};

const videoJob = (overrides: Partial<IGenerationJobDocument> = {}) =>
  ({
    ...base,
    kind: 'video',
    state: 'running',
    progress: 0.4,
    payload: {
      request: {
        model: 'gemini-omni-1.1-flash',
        mode: 'text_to_video',
        prompt: 'a lighthouse',
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '720p',
      },
      providerId: 'gemini-omni',
    },
    ...overrides,
  }) as IGenerationJobDocumentOf<'video'>;

const musicJob = (overrides: Partial<IGenerationJobDocument> = {}) =>
  ({
    ...base,
    kind: 'music',
    state: 'running',
    payload: {
      request: {
        model: 'test-music',
        prompt: 'a sea shanty',
        lyrics: 'la la la',
        instrumental: false,
        durationSeconds: 5,
      },
      providerId: 'test',
    },
    ...overrides,
  }) as IGenerationJobDocumentOf<'music'>;

const deps = (signed: SignedOutput): JobMapperDeps => ({
  sign: async () => signed,
  now: () => new Date('2026-10-06T00:02:00Z'),
});
const ready = deps({ availability: 'ready', url: 'https://signed.example/out' });

const videoSucceeded = (location: 'files' | 'generated') =>
  videoJob({
    state: 'succeeded',
    settledCredits: 100,
    progress: 1,
    payload: {
      ...videoJob().payload,
      output: {
        location,
        s3Key: 'generated-video/j.mp4',
        ...(location === 'files' && { fileId: 'f1' }),
        contentType: 'video/mp4',
        bytes: 10,
        durationSeconds: 6,
      },
    },
  });

const musicSucceeded = (location: 'files' | 'generated') =>
  musicJob({
    state: 'succeeded',
    settledCredits: 80,
    payload: {
      ...musicJob().payload,
      output: {
        location,
        s3Key: 'generated-audio/j.mp3',
        ...(location === 'files' && { fileId: 'f1' }),
        contentType: 'audio/mpeg',
        bytes: 10,
        durationSeconds: 5,
        lyrics: 'sung lines',
      },
    },
  });

describe('public v1 video resource bytes', () => {
  it('renders an in-flight job', async () => {
    expect(JSON.stringify(await toPublicVideoGeneration(videoJob(), ready))).toMatchSnapshot();
  });

  it.each(['files', 'generated'] as const)('renders a succeeded job stored in %s', async location => {
    expect(JSON.stringify(await toPublicVideoGeneration(videoSucceeded(location), ready))).toMatchSnapshot();
  });

  it('renders an output still being scanned', async () => {
    const pending = deps({ availability: 'pending_scan' });
    expect(JSON.stringify(await toPublicVideoGeneration(videoSucceeded('files'), pending))).toMatchSnapshot();
  });

  it.each(GENERATION_JOB_ERROR_CODES)('renders a job failed with %s', async code => {
    const failed = videoJob({ state: 'failed', error: { code, message: 'provider wording' } });
    expect(JSON.stringify(await toPublicVideoGeneration(failed, ready))).toMatchSnapshot();
  });
});

describe('public v1 music resource bytes', () => {
  it('renders an in-flight job', async () => {
    expect(JSON.stringify(await toPublicMusicGeneration(musicJob(), ready))).toMatchSnapshot();
  });

  it.each(['files', 'generated'] as const)('renders a succeeded job stored in %s', async location => {
    expect(JSON.stringify(await toPublicMusicGeneration(musicSucceeded(location), ready))).toMatchSnapshot();
  });

  it('renders an output that is unavailable', async () => {
    const gone = deps({ availability: 'unavailable' });
    expect(JSON.stringify(await toPublicMusicGeneration(musicSucceeded('generated'), gone))).toMatchSnapshot();
  });

  it.each(GENERATION_JOB_ERROR_CODES)('renders a job failed with %s', async code => {
    const failed = musicJob({ state: 'failed', error: { code, message: 'provider wording' } });
    expect(JSON.stringify(await toPublicMusicGeneration(failed, ready))).toMatchSnapshot();
  });
});
