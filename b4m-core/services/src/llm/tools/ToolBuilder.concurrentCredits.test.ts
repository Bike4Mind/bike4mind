import { describe, expect, it, vi } from 'vitest';
import { ImageModels, type ModelInfo } from '@bike4mind/common';
import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { estimateImageCredits } from '../../imageCost';
import { estimateAudioCredits } from '../../audioCost';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import { toImageCostInput, type ImageToolCostInput, type ImageToolName } from './imageToolBilling';

const model = { id: ImageModels.GPT_IMAGE_2, backend: 'openai' } as ModelInfo;
const lowQuality = { model: model.id, n: 1, quality: 'low' } as const;
const highQuality = { ...lowQuality, quality: 'high' } as const;
const imageCredits = (input: ImageToolCostInput) => estimateImageCredits(model, 1, input).requiredCredits;
const lowCredits = imageCredits(lowQuality);
const highCredits = imageCredits(highQuality);

function makeBuilder(credits: number) {
  const toolCreditsMap = new Map<string, number[]>();
  const dependencies = {
    user: { id: 'user-1', currentCredits: credits },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() },
    db: { creditTransactions: {}, usageEvents: { record: vi.fn().mockResolvedValue(undefined) } },
    toolCreditsMap,
    toolCreditModels: new Set<string>(),
  } as unknown as ToolBuilderConfig;
  return { builder: new ToolBuilder(dependencies), toolCreditsMap };
}

function trackedTool(builder: ToolBuilder, name: string, run: () => Promise<string>) {
  const tool: ICompletionOptionTools = {
    toolSchema: { name, description: '', parameters: { type: 'object', properties: {} } },
    toolFn: run,
  };
  // Exercise the same invocation wrapper buildTools installs around the real media tools.
  const tracker = builder as unknown as {
    trackGatedCalls(tools: ICompletionOptionTools[]): ICompletionOptionTools[];
  };
  return tracker.trackGatedCalls([tool])[0];
}

function imageCall(
  builder: ToolBuilder,
  input: ImageToolCostInput,
  outcome: 'success' | 'failure' | 'throw' = 'success',
  name: ImageToolName = 'image_generation'
) {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const provider = vi.fn();
  const tool = trackedTool(builder, name, async () => {
    await builder.gateImageCredits(name, input, true, null, [model]);
    provider();
    started.resolve();
    await finish.promise;
    if (outcome === 'throw') throw new Error('provider failed');
    if (outcome === 'failure') return 'provider failed';
    builder.settleImageCredits(
      name,
      { id: 'quest-1', sessionId: 'session-1', creditsUsed: 0, images: [] } as never,
      { ...input, paths: ['image.png'] },
      true,
      null,
      [model]
    );
    return 'generated';
  });
  return { tool, started: started.promise, finish: finish.resolve, provider };
}

describe('concurrent media credit admission', () => {
  it.each(['image_generation', 'edit_image'] as const)(
    'admits only one concurrent %s call when the balance covers one',
    async name => {
      const requiredCredits = estimateImageCredits(model, 1, toImageCostInput(name, highQuality)).requiredCredits;
      const { builder } = makeBuilder(requiredCredits);
      const first = imageCall(builder, highQuality, 'success', name);
      const second = imageCall(builder, highQuality, 'success', name);
      const results = Promise.allSettled([first.tool.toolFn(), second.tool.toolFn()]);
      await first.started;
      first.finish();
      second.finish();
      const outcomes = await results;
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(first.provider).toHaveBeenCalledOnce();
      expect(second.provider).not.toHaveBeenCalled();
    }
  );

  it.each(['failure', 'throw'] as const)(
    'keeps the expensive estimate when the later cheap call ends with %s',
    async outcome => {
      const { builder, toolCreditsMap } = makeBuilder(highCredits + lowCredits);
      const expensive = imageCall(builder, highQuality);
      const cheap = imageCall(builder, lowQuality, outcome);
      const expensiveResult = expensive.tool.toolFn();
      await expensive.started;
      const cheapResult = Promise.allSettled([cheap.tool.toolFn()]);
      await cheap.started;
      cheap.finish();
      await cheapResult;

      await expect(builder.gateImageCredits('image_generation', highQuality, true, null, [model])).rejects.toThrow(
        /enough personal credits/
      );
      expensive.finish();
      await expensiveResult;
      expect(toolCreditsMap.get('image_generation')).toEqual([highCredits]);
    }
  );

  it('releases the expensive estimate when it fails before the earlier cheap call', async () => {
    const { builder } = makeBuilder(highCredits + lowCredits);
    const cheap = imageCall(builder, lowQuality);
    const expensive = imageCall(builder, highQuality, 'failure');
    const cheapResult = cheap.tool.toolFn();
    await cheap.started;
    const expensiveResult = expensive.tool.toolFn();
    await expensive.started;
    expensive.finish();
    await expensiveResult;

    const retry = imageCall(builder, highQuality);
    const retryResult = retry.tool.toolFn();
    await retry.started;
    cheap.finish();
    retry.finish();
    await Promise.all([cheapResult, retryResult]);
    expect(retry.provider).toHaveBeenCalledOnce();
  });

  it('replaces only the completed call estimate when the cheap call settles first', async () => {
    const { builder, toolCreditsMap } = makeBuilder(highCredits + lowCredits);
    const expensive = imageCall(builder, highQuality);
    const cheap = imageCall(builder, lowQuality);
    const expensiveResult = expensive.tool.toolFn();
    await expensive.started;
    const cheapResult = cheap.tool.toolFn();
    await cheap.started;
    cheap.finish();
    await cheapResult;

    await expect(builder.gateImageCredits('image_generation', lowQuality, true, null, [model])).rejects.toThrow(
      /enough personal credits/
    );
    expensive.finish();
    await expensiveResult;
    expect(toolCreditsMap.get('image_generation')).toEqual([lowCredits, highCredits]);
  });

  it('does not release an active estimate when a second call is refused at admission', async () => {
    const { builder } = makeBuilder(highCredits);
    const first = imageCall(builder, highQuality);
    const firstResult = first.tool.toolFn();
    await first.started;
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = imageCall(builder, highQuality);
      await expect(refused.tool.toolFn()).rejects.toThrow(/enough personal credits/);
      expect(refused.provider).not.toHaveBeenCalled();
    }
    first.finish();
    await firstResult;
  });

  it('accounts for an image estimate before a concurrent audio gate checks the balance', async () => {
    const { builder } = makeBuilder(highCredits);
    const image = imageCall(builder, highQuality);
    const imageResult = image.tool.toolFn();
    // Do not await the image gate: this is the interleaving that previously read stale commitments.
    expect(() =>
      builder.gateAudioCredits({ kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 }, true)
    ).toThrow(/enough personal credits/);
    image.finish();
    await imageResult;
  });

  it('keeps an audio estimate when a later, cheaper audio call fails', async () => {
    const speech = { kind: 'speech', provider: 'openai', model: 'tts-1', characters: 1000 } as const;
    const smallSpeech = { ...speech, characters: 100 };
    const speechCredits = estimateAudioCredits(speech).requiredCredits;
    const smallCredits = estimateAudioCredits(smallSpeech).requiredCredits;
    const { builder } = makeBuilder(speechCredits + smallCredits);
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const first = trackedTool(builder, 'audio_generation', async () => {
      builder.gateAudioCredits(speech, true);
      started.resolve();
      await finish.promise;
      return 'failed';
    });
    const second = trackedTool(builder, 'audio_generation', async () => {
      builder.gateAudioCredits(smallSpeech, true);
      return 'failed';
    });
    const firstResult = first.toolFn();
    await started.promise;
    await second.toolFn();
    expect(() => builder.gateAudioCredits(speech, true)).toThrow(/enough personal credits/);
    finish.resolve();
    await firstResult;
    expect(() => builder.gateAudioCredits(speech, true)).not.toThrow();
  });
});
