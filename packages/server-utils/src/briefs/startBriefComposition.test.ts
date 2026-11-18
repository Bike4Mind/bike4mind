import { describe, expect, it, vi } from 'vitest';
import type { IAssistantBrief } from '@bike4mind/database';
import { startBriefComposition } from './startBriefComposition';

const now = new Date('2026-11-17T12:00:00Z');
const stored = (overrides: Partial<IAssistantBrief> = {}) =>
  ({
    _id: 'b1',
    userId: 'u1',
    periodStart: new Date('2026-11-16T12:00:00Z'),
    periodEnd: now,
    ...overrides,
  }) as unknown as IAssistantBrief;

const makeDeps = (over: { inFlight?: IAssistantBrief | null; latest?: IAssistantBrief | null } = {}) => ({
  briefs: {
    findActiveComposing: vi.fn().mockResolvedValue(over.inFlight ?? null),
    findLatestReady: vi.fn().mockResolvedValue(over.latest ?? null),
    createComposing: vi.fn().mockImplementation(async input => stored(input)),
    discardComposing: vi.fn().mockResolvedValue(true),
  },
  publishCompose: vi.fn().mockResolvedValue(undefined),
  now: () => now,
});

describe('startBriefComposition', () => {
  it('returns the in-flight brief without publishing a second compose event', async () => {
    const deps = makeDeps({ inFlight: stored({ status: 'composing' }) });
    const brief = await startBriefComposition('u1', deps);
    expect(brief._id).toBe('b1');
    expect(deps.briefs.createComposing).not.toHaveBeenCalled();
    expect(deps.publishCompose).not.toHaveBeenCalled();
  });

  it('starts from the last ready brief and publishes the compose event', async () => {
    const lastEnd = new Date('2026-11-17T06:00:00Z');
    const deps = makeDeps({ latest: stored({ periodEnd: lastEnd }) });
    await startBriefComposition('u1', deps);
    expect(deps.briefs.createComposing).toHaveBeenCalledWith({ userId: 'u1', periodStart: lastEnd, periodEnd: now });
    expect(deps.publishCompose).toHaveBeenCalledWith({ briefId: 'b1', userId: 'u1' });
  });

  it('drops the created row and rethrows when the compose event cannot be published', async () => {
    const deps = makeDeps();
    deps.publishCompose.mockRejectedValue(new Error('PutEvents failed'));
    await expect(startBriefComposition('u1', deps)).rejects.toThrow('PutEvents failed');
    expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
  });

  it('defaults to the last day with no prior brief and caps a stale one at a week', async () => {
    const first = makeDeps();
    await startBriefComposition('u1', first);
    expect(first.briefs.createComposing.mock.calls[0][0].periodStart).toEqual(new Date('2026-11-16T12:00:00Z'));

    const stale = makeDeps({ latest: stored({ periodEnd: new Date('2026-10-01T00:00:00Z') }) });
    await startBriefComposition('u1', stale);
    expect(stale.briefs.createComposing.mock.calls[0][0].periodStart).toEqual(new Date('2026-11-10T12:00:00Z'));
  });
});
