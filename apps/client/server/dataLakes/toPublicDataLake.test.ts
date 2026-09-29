import { describe, expect, it, vi } from 'vitest';
import { DATA_LAKES, DataLakeResourceSchema } from '@bike4mind/common';
import { loadRegistryLakeStats, toPublicDataLake } from './toPublicDataLake';

const registryLake = DATA_LAKES[0];

const dbLake = {
  id: '65a000000000000000000001',
  name: 'Handbook',
  slug: 'handbook',
  description: 'Company handbook',
  organizationId: '65a0000000000000000000aa',
  isPublic: true,
  status: 'active' as const,
  fileCount: 3,
  totalSizeBytes: 4096,
  lastSyncAt: new Date('2026-01-02T03:04:05.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-03T00:00:00.000Z'),
};

describe('toPublicDataLake', () => {
  it('projects a DB lake onto the snake_case public shape with ISO timestamps', () => {
    const resource = toPublicDataLake(dbLake);
    expect(resource).toEqual({
      id: dbLake.id,
      name: 'Handbook',
      slug: 'handbook',
      description: 'Company handbook',
      organization_id: dbLake.organizationId,
      is_public: true,
      built_in: false,
      status: 'active',
      file_count: 3,
      total_size_bytes: 4096,
      last_sync_at: '2026-01-02T03:04:05.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
    });
    expect(DataLakeResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('never leaks a field outside the public shape, even from a full editor document', () => {
    const editorDoc = { ...dbLake, systemPrompt: 'secret', requiredUserTag: 'vip', createdByUserId: 'u1' };
    const resource = toPublicDataLake(editorDoc);
    expect(Object.keys(resource).sort()).toEqual(Object.keys(DataLakeResourceSchema.shape).sort());
    expect(JSON.stringify(resource)).not.toContain('secret');
  });

  it('fills absent optional fields with null, false, 0 and an active status', () => {
    const resource = toPublicDataLake({ id: dbLake.id, name: 'Bare', slug: 'bare' });
    expect(resource).toMatchObject({
      description: null,
      organization_id: null,
      is_public: false,
      status: 'active',
      file_count: 0,
      total_size_bytes: 0,
      last_sync_at: null,
      created_at: null,
      updated_at: null,
    });
    expect(DataLakeResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('accepts timestamps that already crossed the wire as strings', () => {
    const resource = toPublicDataLake({
      ...dbLake,
      createdAt: '2026-01-01T00:00:00.000Z' as unknown as Date,
    });
    expect(resource.created_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('marks a registry lake built_in, prefers live stats and nulls its synthetic timestamps', () => {
    const resource = toPublicDataLake(
      {
        id: registryLake.id,
        name: registryLake.name,
        slug: registryLake.slug,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      { fileCount: 12, totalSizeBytes: 999 }
    );
    expect(resource).toMatchObject({
      built_in: true,
      file_count: 12,
      total_size_bytes: 999,
      created_at: null,
      updated_at: null,
    });
  });
});

describe('loadRegistryLakeStats', () => {
  it('computes live counts for a registry lake', async () => {
    const computeDataLakeStats = vi.fn().mockResolvedValue({ fileCount: 7, totalSizeBytes: 70, totalChunkedChars: 1 });
    await expect(loadRegistryLakeStats(registryLake, { fabFiles: { computeDataLakeStats } })).resolves.toEqual({
      fileCount: 7,
      totalSizeBytes: 70,
    });
    expect(computeDataLakeStats).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'registry', datalakeTag: registryLake.datalakeTag })
    );
  });

  it('skips the aggregate for a DB lake', async () => {
    const computeDataLakeStats = vi.fn();
    await expect(
      loadRegistryLakeStats(
        { id: dbLake.id, datalakeTag: 'datalake:x', fileTagPrefix: 'x:' },
        { fabFiles: { computeDataLakeStats } }
      )
    ).resolves.toBeUndefined();
    expect(computeDataLakeStats).not.toHaveBeenCalled();
  });

  it('degrades to undefined and logs when the aggregate fails', async () => {
    const computeDataLakeStats = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = { error: vi.fn() };
    await expect(
      loadRegistryLakeStats(registryLake, { fabFiles: { computeDataLakeStats }, logger: logger as never })
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('stats unavailable'), expect.anything());
  });
});
