import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantBriefModel, assistantBriefRepository } from './AssistantBriefModel';

afterEach(() => vi.restoreAllMocks());

describe('assistant brief settlement', () => {
  it('validates ready content while settling only a composing brief', async () => {
    const update = vi.spyOn(AssistantBriefModel, 'updateOne').mockResolvedValue({ modifiedCount: 1 } as never);
    const content = { headline: 'Ready', happened: [], handled: [], decisions: [] };
    const composedAt = new Date('2026-01-01');

    expect(await assistantBriefRepository.markReady('brief', content, composedAt)).toBe(true);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: 'brief', status: 'composing' },
      { $set: { ...content, status: 'ready', composedAt } },
      { runValidators: true }
    );
  });

  it('validates failure details without claiming an already settled brief changed', async () => {
    const update = vi.spyOn(AssistantBriefModel, 'updateOne').mockResolvedValue({ modifiedCount: 0 } as never);

    expect(await assistantBriefRepository.markFailed('brief', 'Unavailable')).toBe(false);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: 'brief', status: 'composing' },
      { $set: { status: 'failed', failureReason: 'Unavailable' } },
      { runValidators: true }
    );
  });
});
