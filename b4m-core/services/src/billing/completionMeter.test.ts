import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { meterCompletionBackend, type CompletionMeter } from './completionMeter';

const modelInfo = { id: 'm', backend: 'anthropic' } as ModelInfo;

function setup(completeImpl: (cb: (t: string[], info?: object) => Promise<void>) => Promise<void>) {
  const settle = vi.fn().mockResolvedValue(1);
  const refund = vi.fn().mockResolvedValue(undefined);
  const meter = vi.fn<CompletionMeter>().mockResolvedValue({ settle, refund });
  const llm = {
    currentModel: 'm',
    complete: vi.fn(async (_m: string, _msgs: unknown, _o: unknown, cb: never) => completeImpl(cb)),
    other: function (this: { currentModel: string }) {
      return this.currentModel;
    },
  };
  return { llm, meter, settle, refund, metered: meterCompletionBackend(llm as never, meter, modelInfo) as typeof llm };
}

describe('meterCompletionBackend', () => {
  it('reserves before the provider call and settles the latched usage once', async () => {
    const { llm, meter, settle, refund, metered } = setup(async cb => {
      await cb(['a'], { inputTokens: 10 });
      await cb(['b'], { outputTokens: 5 });
    });
    const seen: string[] = [];
    await metered.complete('m', [], { maxTokens: 100 }, async (t: string[]) => void seen.push(...t));
    expect(meter).toHaveBeenCalledWith(modelInfo, [], 100, undefined);
    expect(meter.mock.invocationCallOrder[0]).toBeLessThan(llm.complete.mock.invocationCallOrder[0]);
    expect(settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 10, outputTokens: 5 });
    expect(refund).not.toHaveBeenCalled();
    expect(seen).toEqual(['a', 'b']);
  });

  it('never calls the provider when the reservation is refused', async () => {
    const { llm, meter, metered } = setup(async () => {});
    meter.mockRejectedValue(Object.assign(new Error('insufficient'), { statusCode: 422 }));
    await expect(metered.complete('m', [], {}, async () => {})).rejects.toThrow('insufficient');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('refunds and rethrows when the provider call fails', async () => {
    const { settle, refund, metered } = setup(async () => {
      throw new Error('provider down');
    });
    await expect(metered.complete('m', [], {}, async () => {})).rejects.toThrow('provider down');
    expect(refund).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();
  });

  it('passes other members through to the backend', () => {
    const { metered } = setup(async () => {});
    expect(metered.other()).toBe('m');
    expect(metered.currentModel).toBe('m');
  });
});
