import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import {
  ImageModerationBlockedError,
  type ImageModerationService,
  type ModerationLabelHit,
} from '@bike4mind/utils/imageModeration';
import { moderateImageOrThrow } from './imageModerationGate';

const labels: ModerationLabelHit[] = [{ name: 'Explicit Nudity', parentName: '', confidence: 97.5 }];

function makeMeta() {
  return { userId: 'u1', sessionId: 's1', questId: 'q1', provider: 'openai', model: 'gpt-image-1' };
}

describe('moderateImageOrThrow (moderation gate)', () => {
  // These cases assert the hosted-mode behavior, so pin B4M_SELF_HOST off
  // (the self-host branch short-circuits before any of them run).
  const savedSelfHost = process.env.B4M_SELF_HOST;
  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
  });
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
  });

  it('self-host: returns without calling checkImage (Rekognition gate skipped)', async () => {
    process.env.B4M_SELF_HOST = 'true';
    const service: ImageModerationService = { checkImage: vi.fn() };
    const record = vi.fn();

    await expect(
      moderateImageOrThrow({
        service,
        enabled: true,
        incidents: { record },
        buffer: Buffer.from('bytes'),
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      })
    ).resolves.toBeUndefined();

    expect(service.checkImage).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('block: throws ImageModerationBlockedError and records the incident once', async () => {
    const service: ImageModerationService = {
      checkImage: vi.fn().mockRejectedValue(new ImageModerationBlockedError(labels)),
    };
    const record = vi.fn().mockResolvedValue(undefined);

    await expect(
      moderateImageOrThrow({
        service,
        enabled: true,
        incidents: { record },
        buffer: Buffer.from('bytes'),
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      })
    ).rejects.toBeInstanceOf(ImageModerationBlockedError);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ ...makeMeta(), labels });
  });

  it('block + incidents.record rejects: still throws the ORIGINAL block error, not the DB error, and record was attempted', async () => {
    const service: ImageModerationService = {
      checkImage: vi.fn().mockRejectedValue(new ImageModerationBlockedError(labels)),
    };
    const record = vi.fn().mockRejectedValue(new Error('db unavailable'));

    let caught: unknown;
    try {
      await moderateImageOrThrow({
        service,
        enabled: true,
        incidents: { record },
        buffer: Buffer.from('bytes'),
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ImageModerationBlockedError);
    expect((caught as ImageModerationBlockedError).labels).toEqual(labels);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('non-block error from checkImage (fail-closed): re-throws unchanged and does not record an incident', async () => {
    const unavailable = new Error('[ImageModeration] moderation unavailable after 3 attempts');
    const service: ImageModerationService = {
      checkImage: vi.fn().mockRejectedValue(unavailable),
    };
    const record = vi.fn();

    await expect(
      moderateImageOrThrow({
        service,
        enabled: true,
        incidents: { record },
        buffer: Buffer.from('bytes'),
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      })
    ).rejects.toBe(unavailable);

    expect(record).not.toHaveBeenCalled();
  });

  it('clean image: resolves, checkImage was called, and no incident is recorded', async () => {
    const service: ImageModerationService = {
      checkImage: vi.fn().mockResolvedValue(undefined),
    };
    const record = vi.fn();
    const buffer = Buffer.from('bytes');

    await expect(
      moderateImageOrThrow({
        service,
        enabled: true,
        incidents: { record },
        buffer,
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      })
    ).resolves.toBeUndefined();

    expect(service.checkImage).toHaveBeenCalledWith(buffer, 'image/png');
    expect(record).not.toHaveBeenCalled();
  });

  it('enabled=false: checkImage is NOT called (skipped)', async () => {
    const service: ImageModerationService = {
      checkImage: vi.fn(),
    };

    await moderateImageOrThrow({
      service,
      enabled: false,
      incidents: undefined,
      buffer: Buffer.from('bytes'),
      mimeType: 'image/png',
      incidentMeta: makeMeta(),
      logger: Logger.globalInstance,
    });

    expect(service.checkImage).not.toHaveBeenCalled();
  });

  it('service undefined: checkImage never called, a warning is logged, and it resolves (no-op)', async () => {
    const warnSpy = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => undefined);

    await expect(
      moderateImageOrThrow({
        service: undefined,
        enabled: true,
        incidents: undefined,
        buffer: Buffer.from('bytes'),
        mimeType: 'image/png',
        incidentMeta: makeMeta(),
        logger: Logger.globalInstance,
      })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
