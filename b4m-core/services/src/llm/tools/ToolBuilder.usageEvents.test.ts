import { describe, it, expect, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { buildToolUsageEvent, recordToolUsageEvent } from './ToolBuilder';

const quest = { id: 'q1', sessionId: 's1' } as never;
const user = { id: 'u1' } as never;

describe('buildToolUsageEvent', () => {
  it('maps an image tool charge to a tool usage event owned by the user', () => {
    const event = buildToolUsageEvent({
      quest,
      user,
      provider: 'openai',
      model: 'gpt-image-1',
      costUsd: 0.08,
      creditsCharged: 400,
      units: 2,
    });
    expect(event).toMatchObject({
      requestId: 'q1',
      userId: 'u1',
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      sessionId: 's1',
      feature: 'tool',
      provider: 'openai',
      model: 'gpt-image-1',
      inputTokens: 0,
      outputTokens: 0,
      units: 2,
      costUsd: 0.08,
      creditsCharged: 400,
      status: 'ok',
    });
  });

  it('attributes the charge to the organization when one is present', () => {
    const event = buildToolUsageEvent({
      quest,
      user,
      organization: { id: 'org1' } as never,
      provider: 'bedrock',
      model: 'm',
      costUsd: 1,
      creditsCharged: 5000,
    });
    expect(event.ownerId).toBe('org1');
    expect(event.ownerType).toBe(CreditHolderType.Organization);
  });

  it('carries subagent token counts when provided', () => {
    const event = buildToolUsageEvent({
      quest,
      user,
      provider: 'bedrock',
      model: 'm',
      costUsd: 0.01,
      creditsCharged: 50,
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(event.inputTokens).toBe(1200);
    expect(event.outputTokens).toBe(300);
    expect(event.units).toBeUndefined();
  });
});

describe('recordToolUsageEvent', () => {
  it('swallows a rejected record and warns instead of throwing into billing', async () => {
    const warn = vi.fn();
    const db = { usageEvents: { record: vi.fn().mockRejectedValue(new Error('db down')) } };
    recordToolUsageEvent(db as never, { warn } as never, 'image_generation', {} as never);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(db.usageEvents.record).toHaveBeenCalled();
  });

  it('is a no-op when the usage events repository is absent', () => {
    expect(() => recordToolUsageEvent({} as never, { warn: vi.fn() } as never, 'x', {} as never)).not.toThrow();
  });
});
