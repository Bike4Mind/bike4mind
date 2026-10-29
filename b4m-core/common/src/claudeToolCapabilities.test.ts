import { describe, expect, it } from 'vitest';
import {
  chatSupportsDeferredToolAddition,
  completionsSupportsToolChanges,
  completionsSupportsToolSearch,
  supportsAssistantPrefill,
  supportsToolChanges,
  supportsToolSearch,
} from './claudeToolCapabilities';
import { CHAT_MODELS, ChatModels, isClaudeModelId, ModelBackend } from './models';

// [tool search, tool changes, assistant prefill]. Every Claude id in ChatModels must be listed, so a new one forces a decision.
const EXPECTED: Record<string, [boolean, boolean, boolean]> = {
  [ChatModels.CLAUDE_3_HAIKU_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_3_5_HAIKU_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_3_5_SONNET_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_4_OPUS_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_4_1_OPUS_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_4_SONNET_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_3_5_SONNET_V2_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_3_7_SONNET_BEDROCK]: [false, false, true],
  [ChatModels.CLAUDE_4_5_SONNET_BEDROCK]: [true, false, true],
  [ChatModels.CLAUDE_4_5_HAIKU_BEDROCK]: [true, false, true],
  [ChatModels.CLAUDE_4_5_OPUS_BEDROCK]: [true, false, true],
  [ChatModels.CLAUDE_4_6_SONNET_BEDROCK]: [true, false, false],
  [ChatModels.CLAUDE_5_SONNET_BEDROCK]: [true, false, false],
  [ChatModels.CLAUDE_5_5_SONNET_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_4_6_OPUS_BEDROCK]: [true, false, false],
  [ChatModels.CLAUDE_4_7_OPUS_BEDROCK]: [true, false, false],
  [ChatModels.CLAUDE_4_8_OPUS_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_FABLE_5_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_FABLE_5_1_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_5_OPUS_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_5_5_OPUS_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_5_5_HAIKU_BEDROCK]: [true, true, false],
  [ChatModels.CLAUDE_3_OPUS]: [false, false, true],
  [ChatModels.CLAUDE_3_5_HAIKU_ANTHROPIC]: [false, false, true],
  [ChatModels.CLAUDE_3_5_SONNET_ANTHROPIC]: [false, false, true],
  [ChatModels.CLAUDE_3_7_SONNET_ANTHROPIC]: [false, false, true],
  [ChatModels.CLAUDE_4_OPUS]: [false, false, true],
  [ChatModels.CLAUDE_4_1_OPUS]: [false, false, true],
  [ChatModels.CLAUDE_4_SONNET]: [false, false, true],
  [ChatModels.CLAUDE_4_5_SONNET]: [true, false, true],
  [ChatModels.CLAUDE_4_5_HAIKU]: [true, false, true],
  [ChatModels.CLAUDE_4_5_OPUS]: [true, false, true],
  [ChatModels.CLAUDE_4_6_SONNET]: [true, false, false],
  [ChatModels.CLAUDE_5_SONNET]: [true, false, false],
  [ChatModels.CLAUDE_4_6_OPUS]: [true, false, false],
  [ChatModels.CLAUDE_4_7_OPUS]: [true, false, false],
  [ChatModels.CLAUDE_4_8_OPUS]: [true, true, false],
  [ChatModels.CLAUDE_FABLE_5]: [true, true, false],
  [ChatModels.CLAUDE_5_OPUS]: [true, true, false],
  [ChatModels.CLAUDE_5_5_OPUS]: [true, true, false],
  [ChatModels.CLAUDE_5_5_HAIKU]: [true, true, false],
};

const nativeBackend = (id: string) => (id.includes('anthropic.') ? ModelBackend.Bedrock : ModelBackend.Anthropic);
const flags = (id: string, backend = nativeBackend(id)) => [
  supportsToolSearch({ id, backend }),
  supportsToolChanges({ id, backend }),
];

describe('supportsToolSearch / supportsToolChanges', () => {
  it('classifies every Claude id in ChatModels explicitly', () => {
    const claudeIds = CHAT_MODELS.filter(isClaudeModelId);

    expect(Object.keys(EXPECTED).sort()).toEqual([...claudeIds].sort());
    for (const id of claudeIds) {
      expect([...flags(id), supportsAssistantPrefill({ id })], id).toEqual(EXPECTED[id]);
    }
  });

  it.each([
    ['claude-mythos-5-1', [true, true]],
    ['claude-mythos-5', [true, true]],
    ['claude-fable-5-1', [true, true]],
    ['claude-sonnet-5-5', [true, true]],
    ['claude-opus-4-7-20260416', [true, false]],
    ['claude-opus-5-5[1m]', [true, true]],
    ['anthropic.claude-opus-4-8', [true, true]],
    ['eu.anthropic.claude-haiku-4-5-20251001-v1:0', [true, false]],
    ['apac.anthropic.claude-sonnet-5', [true, false]],
    ['jp.anthropic.claude-opus-4-8', [true, true]],
    ['us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0', [true, false]],
    ['claude-opus-4-5-latest', [true, false]],
    ['claude-3-5-sonnet-latest', [false, false]],
    ['claude-opus-4-1', [false, false]],
    ['us.anthropic.claude-opus-4-20250514-v1:0', [false, false]],
    ['anthropic.claude-v2:1', [false, false]],
    ['claude-mythos-preview', [false, false]],
    ['claude-opus-6', [false, false]],
    ['claude-nova-5', [false, false]],
    ['claude-opus-5-50', [false, false]],
    ['claude-opus-5-5-1', [false, false]],
    ['claude-sonnet-4-5-2025', [false, false]],
    ['anthropic/claude-opus-5-5', [false, false]],
  ])('classifies catalog-only and unseen id %s', (id, expected) => {
    expect(flags(id)).toEqual(expected);
  });

  it('is false for a supported Claude id served by any backend but Anthropic or Bedrock', () => {
    expect(flags(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.OpenAI)).toEqual([false, false]);
    expect(flags(ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Ollama)).toEqual([false, false]);
  });

  it('is false for non-Claude models', () => {
    expect(flags(ChatModels.GPT4o, ModelBackend.OpenAI)).toEqual([false, false]);
    expect(flags(ChatModels.GEMINI_2_5_PRO, ModelBackend.Gemini)).toEqual([false, false]);
    expect(flags(ChatModels.DEEPSEEK_R1_BEDROCK, ModelBackend.Bedrock)).toEqual([false, false]);
  });
});

describe('chatSupportsDeferredToolAddition', () => {
  it.each([
    [ChatModels.CLAUDE_5_5_OPUS, ModelBackend.Anthropic, true],
    [ChatModels.CLAUDE_4_8_OPUS, ModelBackend.Anthropic, true],
    ['claude-sonnet-5-5', ModelBackend.Anthropic, true],
    [ChatModels.CLAUDE_5_5_HAIKU, ModelBackend.Anthropic, true],
    [ChatModels.CLAUDE_5_SONNET, ModelBackend.Anthropic, false],
    [ChatModels.CLAUDE_4_7_OPUS, ModelBackend.Anthropic, false],
    [ChatModels.CLAUDE_5_5_OPUS_BEDROCK, ModelBackend.Bedrock, true],
    [ChatModels.CLAUDE_FABLE_5_1_BEDROCK, ModelBackend.Bedrock, true],
    [ChatModels.CLAUDE_5_5_SONNET_BEDROCK, ModelBackend.Bedrock, false],
    [ChatModels.CLAUDE_5_5_HAIKU_BEDROCK, ModelBackend.Bedrock, false],
    [ChatModels.CLAUDE_5_5_OPUS, ModelBackend.OpenAI, false],
    [ChatModels.GPT4o, ModelBackend.OpenAI, false],
  ])('classifies %s on %s', (id, backend, expected) => {
    expect(chatSupportsDeferredToolAddition({ id, backend })).toBe(expected);
  });

  it('follows the adapter family of a catalog row over its backend', () => {
    const id = ChatModels.CLAUDE_5_5_OPUS;
    expect(
      chatSupportsDeferredToolAddition({ id, backend: ModelBackend.Bedrock, adapterFamily: 'anthropic-messages' })
    ).toBe(true);
    expect(
      chatSupportsDeferredToolAddition({
        id: 'claude-sonnet-5-5',
        backend: ModelBackend.Anthropic,
        adapterFamily: 'bedrock-anthropic',
      })
    ).toBe(false);
  });
});

describe('supportsAssistantPrefill', () => {
  it.each([
    ChatModels.CLAUDE_4_6_OPUS,
    ChatModels.CLAUDE_4_7_OPUS,
    ChatModels.CLAUDE_4_8_OPUS,
    ChatModels.CLAUDE_5_OPUS,
    ChatModels.CLAUDE_5_5_OPUS,
    ChatModels.CLAUDE_4_6_SONNET,
    ChatModels.CLAUDE_5_SONNET,
    'claude-sonnet-5-5',
    ChatModels.CLAUDE_5_5_HAIKU,
    ChatModels.CLAUDE_FABLE_5,
    'claude-fable-5-1',
    'claude-mythos-5',
    'claude-mythos-5-1',
  ])('is false for documented non-prefill model %s', id => {
    expect(supportsAssistantPrefill({ id })).toBe(false);
  });

  it.each([ChatModels.CLAUDE_4_5_OPUS, ChatModels.CLAUDE_4_5_SONNET, ChatModels.CLAUDE_4_5_HAIKU, ChatModels.GPT4o])(
    'defaults to true for supported or non-Claude model %s',
    id => {
      expect(supportsAssistantPrefill({ id })).toBe(true);
    }
  );

  it('classifies provider-prefixed and suffixed ids by Claude family version', () => {
    expect(supportsAssistantPrefill({ id: 'global.anthropic.claude-opus-4-6-v1:0' })).toBe(false);
    expect(supportsAssistantPrefill({ id: 'claude-opus-5-5[1m]' })).toBe(false);
  });
});

describe('completionsSupportsToolSearch', () => {
  it('is true where the direct Anthropic adapter serves the model', () => {
    expect(completionsSupportsToolSearch({ id: ChatModels.CLAUDE_5_5_OPUS, backend: ModelBackend.Anthropic })).toBe(
      true
    );
    expect(completionsSupportsToolSearch({ id: ChatModels.CLAUDE_5_SONNET, backend: ModelBackend.Anthropic })).toBe(
      true
    );
  });

  it('is true for a Bedrock row the model predicate accepts, served by the Bedrock Claude adapter', () => {
    expect(flags(ChatModels.CLAUDE_5_5_OPUS_BEDROCK)).toEqual([true, true]);
    expect(
      completionsSupportsToolSearch({ id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK, backend: ModelBackend.Bedrock })
    ).toBe(true);
    expect(
      completionsSupportsToolSearch({ id: ChatModels.CLAUDE_4_5_HAIKU_BEDROCK, backend: ModelBackend.Bedrock })
    ).toBe(true);
  });

  it('is false for a Bedrock Claude row the model predicate rejects and for non-Claude Bedrock models', () => {
    expect(
      completionsSupportsToolSearch({ id: ChatModels.CLAUDE_4_1_OPUS_BEDROCK, backend: ModelBackend.Bedrock })
    ).toBe(false);
    expect(completionsSupportsToolSearch({ id: ChatModels.DEEPSEEK_R1_BEDROCK, backend: ModelBackend.Bedrock })).toBe(
      false
    );
  });

  it('follows adapterFamily over backend, as getLlmByModel dispatches', () => {
    const id = 'claude-opus-5-5';
    expect(
      completionsSupportsToolSearch({ id, backend: ModelBackend.Bedrock, adapterFamily: 'anthropic-messages' })
    ).toBe(true);
    expect(
      completionsSupportsToolSearch({ id, backend: ModelBackend.Anthropic, adapterFamily: 'bedrock-anthropic' })
    ).toBe(true);
    expect(
      completionsSupportsToolSearch({ id, backend: ModelBackend.Anthropic, adapterFamily: 'anthropic-messages' })
    ).toBe(true);
    expect(completionsSupportsToolSearch({ id, backend: ModelBackend.Bedrock, adapterFamily: 'bedrock-llama' })).toBe(
      false
    );
  });

  it('is false for unsupported Claude models and non-Claude models', () => {
    expect(completionsSupportsToolSearch({ id: ChatModels.CLAUDE_4_1_OPUS, backend: ModelBackend.Anthropic })).toBe(
      false
    );
    expect(completionsSupportsToolSearch({ id: ChatModels.GPT4o, backend: ModelBackend.OpenAI })).toBe(false);
  });
});

describe('completionsSupportsToolChanges', () => {
  it('is true for a direct Anthropic model that supports tool changes', () => {
    expect(completionsSupportsToolChanges({ id: ChatModels.CLAUDE_5_5_OPUS, backend: ModelBackend.Anthropic })).toBe(
      true
    );
  });

  it('is false for the Bedrock-served id, which the completions route does not forward natively', () => {
    expect(supportsToolChanges({ id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK, backend: ModelBackend.Bedrock })).toBe(true);
    expect(
      completionsSupportsToolChanges({ id: ChatModels.CLAUDE_5_5_OPUS_BEDROCK, backend: ModelBackend.Bedrock })
    ).toBe(false);
    expect(
      completionsSupportsToolChanges({
        id: 'claude-opus-5-5',
        backend: ModelBackend.Anthropic,
        adapterFamily: 'bedrock-anthropic',
      })
    ).toBe(false);
  });

  it('is false for a Claude model without tool changes and for non-Claude models', () => {
    expect(completionsSupportsToolChanges({ id: ChatModels.CLAUDE_4_1_OPUS, backend: ModelBackend.Anthropic })).toBe(
      false
    );
    expect(completionsSupportsToolChanges({ id: ChatModels.GPT4o, backend: ModelBackend.OpenAI })).toBe(false);
  });
});
