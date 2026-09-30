import { describe, it, expect, vi } from 'vitest';
import { generateSignedUrl, type GetFabFileAdapter } from './get';
import type { IFabFileDocument } from '@bike4mind/common';

function adapters(): GetFabFileAdapter {
  return {
    db: { fabFiles: {} as any, users: {} as any, adminSettings: {} as any },
    storage: { generateSignedUrl: vi.fn() },
  };
}

const fabFile = (over: Partial<IFabFileDocument> = {}) =>
  ({
    id: 'f1',
    moderationStatus: 'clean',
    supersededInLakes: [
      { dataLakeId: 'lake-1', supersededByFabFileId: 'winner-1', decidedByUserId: 'curator-1', decidedAt: new Date() },
    ],
    ...over,
  }) as IFabFileDocument;

describe('generateSignedUrl - curator ruling boundary', () => {
  it('strips supersededInLakes before a file reaches an outward-facing response', async () => {
    const result = await generateSignedUrl(fabFile(), adapters());
    expect(result.supersededInLakes).toBeUndefined();
  });

  it('strips it on the not-yet-serveable early return too', async () => {
    const result = await generateSignedUrl(fabFile({ moderationStatus: 'pending' }), adapters());
    expect(result.supersededInLakes).toBeUndefined();
  });
});
