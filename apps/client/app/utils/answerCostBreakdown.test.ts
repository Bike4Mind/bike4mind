import { describe, it, expect } from 'vitest';
import type { IChatHistoryItem } from '@bike4mind/common';
import { answerCostBreakdown, formatCostParts } from './answerCostBreakdown';

const label = (name: string) => (name === 'image_generation' ? 'Image Generation' : name);
const meta = (value: unknown) => value as IChatHistoryItem['promptMeta'];

describe('answerCostBreakdown', () => {
  it('splits an image answer into the chat model and the image tool', () => {
    const parts = answerCostBreakdown(
      meta({
        model: { name: 'chat-model' },
        tokenUsage: { creditsUsed: 64 },
        functionCalls: [{ name: 'image_generation', creditsUsed: 120, parameters: { prompt: 'a bottle' } }],
      }),
      label
    );
    expect(parts).toEqual([
      { label: 'Chat', credits: 64, model: 'chat-model' },
      { label: 'Image Generation', credits: 120, model: undefined },
    ]);
    expect(formatCostParts(parts)).toBe('Chat 64 + Image Generation 120');
  });

  it('prices the chat share against the model that answered a redirected turn', () => {
    const parts = answerCostBreakdown(
      meta({
        model: { name: 'successor-model' },
        redirectedFrom: 'requested-model',
        tokenUsage: { creditsUsed: 64 },
        functionCalls: [{ name: 'image_generation', creditsUsed: 120, parameters: {} }],
      }),
      label
    );
    expect(parts[0]).toEqual({ label: 'Chat', credits: 64, model: 'successor-model' });
  });

  it('is empty when no tool charged, so a chat-only answer keeps its single total', () => {
    expect(
      answerCostBreakdown(
        meta({ tokenUsage: { creditsUsed: 12 }, functionCalls: [{ name: 'web_search', creditsUsed: 0 }] }),
        label
      )
    ).toEqual([]);
    expect(answerCostBreakdown(undefined, label)).toEqual([]);
  });

  it('sums repeat calls of one tool and keeps different models apart', () => {
    const parts = answerCostBreakdown(
      meta({
        functionCalls: [
          { name: 'image_generation', creditsUsed: 50, parameters: { model: 'a' } },
          { name: 'image_generation', creditsUsed: 30, parameters: { model: 'a' } },
          { name: 'image_generation', creditsUsed: 0.4, parameters: { model: 'b' } },
        ],
      }),
      label
    );
    expect(parts).toEqual([
      { label: 'Image Generation', credits: 80, model: 'a' },
      { label: 'Image Generation', credits: 0.4, model: 'b' },
    ]);
    expect(formatCostParts(parts)).toBe('Image Generation 80 + Image Generation <1');
  });
});
