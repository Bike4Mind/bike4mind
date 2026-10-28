import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const mocks = vi.hoisted(() => ({ admit: vi.fn(), release: vi.fn() }));
vi.mock('@server/utils/untrustedCompletionQuota', () => ({ admitRequestCompletion: mocks.admit }));
import { withRequestCompletionQuota } from './withRequestCompletionQuota';

const request = {} as Request;
const response = {} as Response;

describe('withRequestCompletionQuota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.release.mockResolvedValue(undefined);
    mocks.admit.mockResolvedValue({ release: mocks.release });
  });

  it('refuses before the operation starts', async () => {
    const error = new Error('quota full');
    mocks.admit.mockRejectedValueOnce(error);
    const complete = vi.fn();
    await expect(withRequestCompletionQuota(complete)(request, response)).rejects.toBe(error);
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it.each(['success', 'failure'] as const)('holds the slot until operation %s', async outcome => {
    let settle: () => void = () => {};
    const error = new Error('provider failed');
    const completion = new Promise<string>((resolve, reject) => {
      settle = () => {
        if (outcome === 'failure') reject(error);
        else resolve('answer');
      };
    });
    const complete = vi.fn(() => completion);
    const pending = withRequestCompletionQuota(complete)(request, response);
    const observed =
      outcome === 'failure' ? expect(pending).rejects.toBe(error) : expect(pending).resolves.toBe('answer');
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledWith(request, response, expect.objectContaining({ track: expect.any(Function) }))
    );
    expect(mocks.admit).toHaveBeenCalledWith(request, { holdSlot: true });
    expect(mocks.release).not.toHaveBeenCalled();
    settle();
    await observed;
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'failure'] as const)('retains timed-out provider work until its %s', async outcome => {
    let settle: () => void = () => {};
    const provider = new Promise<void>((resolve, reject) => {
      settle = () => {
        if (outcome === 'failure') reject(new Error('late provider failure'));
        else resolve();
      };
    });
    const handler = withRequestCompletionQuota(async (_req, _res, context) => {
      context.track(provider);
      return 'fallback';
    });
    await expect(handler(request, response)).resolves.toBe('fallback');
    expect(mocks.release).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(mocks.release).toHaveBeenCalledTimes(1));
  });
});
