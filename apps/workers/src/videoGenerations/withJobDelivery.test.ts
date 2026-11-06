import { describe, expect, it, vi } from 'vitest';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';
import { withJobDelivery } from './withJobDelivery';

const delivery = { kind: 'slack' as const, workspaceId: 'w1', channelId: 'C1', threadTs: '1700000000.000100' };

describe('withJobDelivery', () => {
  it('returns null when the caller has no usable video config', () => {
    expect(withJobDelivery(null, delivery, 'note')).toBeNull();
  });

  it('adds the delivery target to every job the tool creates', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true });
    const config: VideoToolConfig = { usableModels: ['test-video'], createJob };
    const wrapped = withJobDelivery(config, delivery, 'It will be posted here.');
    await wrapped?.createJob({
      user: { id: 'u1', organizationId: null },
      request: {},
      source: 'agent',
      questId: 'q1',
    });
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ questId: 'q1', delivery }));
  });

  it('keeps the usable models and carries the note', () => {
    const config: VideoToolConfig = { usableModels: ['test-video'], createJob: vi.fn() };
    const wrapped = withJobDelivery(config, delivery, 'It will be posted here.');
    expect(wrapped).toMatchObject({ usableModels: ['test-video'], deliveryNote: 'It will be posted here.' });
  });
});
