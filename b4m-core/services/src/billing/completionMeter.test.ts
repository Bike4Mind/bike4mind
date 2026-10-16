import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { meterCompletionBackend, type CompletionMeter } from './completionMeter';

const modelInfo = { id: 'm', backend: 'anthropic' } as ModelInfo;

function setup(
  completeImpl: (cb: (t: string[], info?: object) => Promise<void>) => Promise<void>,
  models?: ModelInfo[]
) {
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
  return {
    llm,
    meter,
    settle,
    refund,
    metered: meterCompletionBackend(llm as never, meter, modelInfo, models) as typeof llm,
  };
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

  it('settles the reported usage instead of refunding when the stream callback throws', async () => {
    const { settle, refund, metered } = setup(async cb => {
      await cb(['a'], { inputTokens: 10, outputTokens: 5 });
    });
    const failingCallback = async () => {
      throw new Error('client gone');
    };
    await expect(metered.complete('m', [], {}, failingCallback)).rejects.toThrow('client gone');
    expect(settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 10, outputTokens: 5 });
    expect(refund).not.toHaveBeenCalled();
  });

  it('prices a call by the bound model set entry for its id', async () => {
    const other = { id: 'o', backend: 'openai' } as ModelInfo;
    const { meter, metered } = setup(async () => {}, [modelInfo, other]);
    await metered.complete('o', [], { maxTokens: 10 }, async () => {});
    expect(meter).toHaveBeenCalledWith(other, [], 10, [modelInfo, other]);
  });

  it('refuses a model id outside the bound model set without reserving or calling the provider', async () => {
    const { llm, meter, metered } = setup(async () => {}, [modelInfo]);
    await expect(metered.complete('unlisted', [], {}, async () => {})).rejects.toThrow('not in the metered model set');
    expect(meter).not.toHaveBeenCalled();
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('passes other members through to the backend', () => {
    const { metered } = setup(async () => {});
    expect(metered.other()).toBe('m');
    expect(metered.currentModel).toBe('m');
  });
});
