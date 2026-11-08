// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ updateOne: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ FabFile: { updateOne: h.updateOne } }));
vi.mock('@bike4mind/services/llm/imageModerationGate', () => ({ moderateImageOrThrow: vi.fn() }));
vi.mock('@bike4mind/utils/imageModeration', () => ({ RekognitionImageModerationService: class {} }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({ getFilesStorage: () => ({}) }));
vi.mock('@bike4mind/server-utils/s3/moderateUploadedFile', () => ({ moderateUploadedFile: vi.fn() }));
vi.mock('@bike4mind/server-utils/moderation/imageModerationIncidents', () => ({ imageModerationIncidents: {} }));

import { buildKnowledgeModerationDeps } from './knowledgeModerationDeps';

const claimedAt = new Date('2026-11-01T00:00:00Z');

describe('buildKnowledgeModerationDeps.release', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.updateOne.mockResolvedValue({ matchedCount: 1 });
  });

  it('counts a failed attempt by default', async () => {
    await expect(buildKnowledgeModerationDeps({} as never).release('oid', claimedAt)).resolves.toBe(true);

    const [filter, update] = h.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'oid', moderationStatus: 'scanning', moderationClaimedAt: claimedAt });
    expect(update.$inc).toEqual({ moderationAttempts: 1 });
  });

  it('does not count a deferred scan as an attempt', async () => {
    await buildKnowledgeModerationDeps({} as never).release('oid', claimedAt, { countAttempt: false });

    const [, update] = h.updateOne.mock.calls[0];
    expect(update.$set).toMatchObject({ moderationStatus: 'pending', moderationLastAttemptAt: expect.any(Date) });
    expect(update.$inc).toBeUndefined();
    expect(update.$unset).toEqual({ moderationClaimedAt: 1 });
  });
});
