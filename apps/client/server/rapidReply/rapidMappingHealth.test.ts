import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { findRottedRapidModelIds } from './rapidMappingHealth';

function createModelInfo(overrides: Partial<ModelInfo> & { id: string; backend: ModelBackend }): ModelInfo {
  return {
    type: 'text',
    name: overrides.id,
    contextWindow: 200_000,
    max_tokens: 8192,
    supportsImageVariation: false,
    pricing: { 200000: { input: 0.001, output: 0.005 } },
    ...overrides,
  } as ModelInfo;
}

const BEDROCK_HAIKU_45 = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const bedrockHaiku = createModelInfo({ id: BEDROCK_HAIKU_45, backend: ModelBackend.Bedrock });
const directHaiku = createModelInfo({ id: 'claude-haiku-4-5-20251001', backend: ModelBackend.Anthropic });

describe('findRottedRapidModelIds', () => {
  it('flags a mapping whose model the catalog has hidden', () => {
    const rotted = findRottedRapidModelIds([{ rapidModelId: BEDROCK_HAIKU_45 }], [directHaiku]);

    expect(rotted).toEqual([BEDROCK_HAIKU_45]);
  });

  it('does not flag a mapping whose model is listed and enabled', () => {
    const rotted = findRottedRapidModelIds([{ rapidModelId: BEDROCK_HAIKU_45 }], [bedrockHaiku, directHaiku]);

    expect(rotted).toEqual([]);
  });

  it('flags a listed-but-disabled model, which can never run', () => {
    const rotted = findRottedRapidModelIds(
      [{ rapidModelId: BEDROCK_HAIKU_45 }],
      [{ ...bedrockHaiku, disabled: true, disabledReason: 'gated' }]
    );

    expect(rotted).toEqual([BEDROCK_HAIKU_45]);
  });

  it('treats a sunset id whose successor is live as healthy', () => {
    // anthropic.claude-3-haiku-20240307-v1:0 -> us.anthropic.claude-haiku-4-5-20251001-v1:0.
    // The request lands on the successor, so the row needs no operator attention.
    const rotted = findRottedRapidModelIds(
      [{ rapidModelId: 'anthropic.claude-3-haiku-20240307-v1:0' }],
      [bedrockHaiku, directHaiku]
    );

    expect(rotted).toEqual([]);
  });

  it('reports each rotted id once even when several mappings share it', () => {
    const rotted = findRottedRapidModelIds(
      [{ rapidModelId: BEDROCK_HAIKU_45 }, { rapidModelId: BEDROCK_HAIKU_45 }, { rapidModelId: 'gpt-4o-mini' }],
      [directHaiku]
    );

    expect(rotted).toEqual([BEDROCK_HAIKU_45, 'gpt-4o-mini']);
  });

  it('returns nothing for no mappings', () => {
    expect(findRottedRapidModelIds([], [directHaiku])).toEqual([]);
  });
});
