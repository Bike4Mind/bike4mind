/**
 * The effort this backend sends on `output_config`, which was hardcoded to
 * 'high' ('medium' for QuestMaster) before a caller could state one. Everything
 * here is asserted on the captured request body: the point of the fix is which
 * value reaches the wire, and an unstated turn must still reach it with exactly
 * the value it carried before.
 */

import { describe, it, expect } from 'vitest';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';
import type { ICompletionOptions } from './backend';
import { ANTHROPIC_EFFORT_LEVELS, type AnthropicEffort } from './thinkingParams';

const SENTINEL = new Error('captured-params-sentinel');

function buildBackend() {
  const backend = new AnthropicBackend('test-key');
  const captured: Record<string, unknown>[] = [];
  (backend as unknown as { _api: unknown })._api = {
    messages: {
      create: async (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        throw SENTINEL;
      },
      stream: (apiParams: Record<string, unknown>) => {
        captured.push(apiParams);
        throw SENTINEL;
      },
    },
  };
  return { backend, getCaptured: () => captured };
}

/** The request body for one turn, with thinking enabled so output_config is in play. */
async function capture(
  options: Partial<ICompletionOptions> & { questMaster?: boolean },
  model: string = ChatModels.CLAUDE_5_OPUS
): Promise<Record<string, unknown>> {
  const { backend, getCaptured } = buildBackend();
  try {
    await backend.complete(
      model,
      [{ role: 'user', content: 'hi' }],
      { stream: true, thinking: { enabled: true, budget_tokens: 16000 }, ...options },
      async () => undefined
    );
  } catch (err) {
    if (err !== SENTINEL) throw err;
  }
  return getCaptured()[0];
}

const effortOf = (params: Record<string, unknown>): AnthropicEffort | undefined =>
  (params.output_config as { effort: AnthropicEffort } | undefined)?.effort;

describe('AnthropicBackend output_config.effort', () => {
  describe('a turn that states no effort is priced exactly as before', () => {
    it('sends high for an ordinary turn', async () => {
      expect(effortOf(await capture({}))).toBe('high');
    });

    it('sends medium for a QuestMaster turn', async () => {
      expect(effortOf(await capture({ questMaster: true, thinking: undefined }))).toBe('medium');
    });

    // The two option spellings being present-but-undefined must read the same as absent.
    it('sends high when both effort options are explicitly undefined', async () => {
      expect(effortOf(await capture({ anthropicEffort: undefined, reasoningEffort: undefined }))).toBe('high');
    });
  });

  describe('a caller can choose the level', () => {
    it.each(ANTHROPIC_EFFORT_LEVELS)('sends %s from anthropicEffort', async level => {
      expect(effortOf(await capture({ anthropicEffort: level }))).toBe(level);
    });

    it('overrides the QuestMaster default', async () => {
      expect(effortOf(await capture({ questMaster: true, thinking: undefined, anthropicEffort: 'xhigh' }))).toBe(
        'xhigh'
      );
    });
  });

  describe('reasoningEffort is translated, never forwarded raw', () => {
    it('maps the four shared levels unchanged', async () => {
      expect(effortOf(await capture({ reasoningEffort: 'low' }))).toBe('low');
      expect(effortOf(await capture({ reasoningEffort: 'medium' }))).toBe('medium');
      expect(effortOf(await capture({ reasoningEffort: 'high' }))).toBe('high');
      expect(effortOf(await capture({ reasoningEffort: 'xhigh' }))).toBe('xhigh');
    });

    // 'none' and 'minimal' are OpenAI levels; Anthropic would reject them, and a
    // Claude model cannot be asked not to think at all.
    it.each(['none', 'minimal'] as const)('never puts %s on the wire', async value => {
      const sent = effortOf(await capture({ reasoningEffort: value }));
      expect(sent).toBe('low');
      expect(ANTHROPIC_EFFORT_LEVELS).toContain(sent);
    });

    it('yields to an explicit anthropicEffort', async () => {
      expect(effortOf(await capture({ anthropicEffort: 'max', reasoningEffort: 'low' }))).toBe('max');
    });
  });

  describe('models that do not take the parameter', () => {
    // A legacy Claude uses budget_tokens instead; output_config would be rejected.
    it('sends no output_config for a legacy thinking model', async () => {
      const params = await capture({ anthropicEffort: 'max' }, ChatModels.CLAUDE_4_6_OPUS);
      expect(params.output_config).toBeUndefined();
      expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    });

    // Effort rides the thinking config, so a turn that never enables thinking sends none.
    it('sends no output_config when thinking is not enabled', async () => {
      const { backend, getCaptured } = buildBackend();
      try {
        await backend.complete(
          ChatModels.CLAUDE_5_OPUS,
          [{ role: 'user', content: 'hi' }],
          { stream: true, anthropicEffort: 'max' },
          async () => undefined
        );
      } catch (err) {
        if (err !== SENTINEL) throw err;
      }
      expect(getCaptured()[0].output_config).toBeUndefined();
    });
  });
});
