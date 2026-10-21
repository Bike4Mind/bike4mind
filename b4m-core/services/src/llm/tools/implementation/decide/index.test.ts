import { describe, expect, it, vi } from 'vitest';
import { DECISION_PLATFORM_LIMITS } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import { decideTool } from '.';

const QUESTIONS = [
  { type: 'predicate' as const, name: 'is_urgent', instructions: 'Needs a reply within 24 hours.' },
  {
    type: 'choice' as const,
    name: 'team',
    instructions: 'Which team?',
    choices: [{ value: 'billing' }, { value: 'technical' }],
  },
];

const context = (decide?: ToolContext['decide']) =>
  ({
    userId: 'u1',
    user: { id: 'u1' },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    authOrigin: 'session',
    decide,
  }) as unknown as ToolContext;

describe('decide tool', () => {
  it('passes the answers through in question order with the resolved model', async () => {
    const decide = vi.fn(async () => ({
      id: 'dec_1',
      object: 'decision' as const,
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate' as const, name: 'is_urgent', probability: 0.93 },
        { type: 'refusal' as const, name: 'team' },
      ],
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
    }));

    const result = await decideTool.implementation(context(decide)).toolFn({ input: 'x', questions: QUESTIONS });

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', request: { model: undefined, input: 'x', questions: QUESTIONS } })
    );
    expect(JSON.parse(result as string)).toEqual({
      id: 'dec_1',
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'is_urgent', probability: 0.93 },
        { type: 'refusal', name: 'team' },
      ],
    });
  });

  it('refuses on a surface with no hook instead of returning a partial payload', async () => {
    await expect(decideTool.implementation(context()).toolFn({ input: 'x', questions: QUESTIONS })).rejects.toThrow(
      'decide is not available on this surface'
    );
  });

  it('passes the trusted turn principal and active account independently of model arguments', async () => {
    const decide = vi.fn(async () => ({ id: 'dec_1', model: 'test-decisions', answers: [] }) as never);
    const toolContext = {
      ...context(decide),
      authOrigin: 'apiKey' as const,
      apiKeyId: 'key-1',
      organizationId: 'org-2',
    };

    await decideTool.implementation(toolContext).toolFn({ input: 'x', questions: QUESTIONS });

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        authOrigin: 'apiKey',
        apiKeyId: 'key-1',
        organizationId: 'org-2',
      })
    );
  });

  it.each([
    ['file image', [{ type: 'image', file_id: 'private-file' }]],
    ['inline image', [{ type: 'image', image_url: 'data:image/png;base64,YQ==' }]],
    ['structured text', [{ type: 'text', text: 'x' }]],
    ['empty text', ''],
    ['oversized text', 'x'.repeat(DECISION_PLATFORM_LIMITS.maxTextLength + 1)],
  ])('rejects %s before reaching the runner', async (_label, input) => {
    const decide = vi.fn();

    await expect(decideTool.implementation(context(decide)).toolFn({ input, questions: QUESTIONS })).rejects.toThrow();

    expect(decide).not.toHaveBeenCalled();
  });

  it('rejects an injected billing principal instead of forwarding model-supplied identity', async () => {
    const decide = vi.fn();

    await expect(
      decideTool.implementation(context(decide)).toolFn({
        input: 'x',
        questions: QUESTIONS,
        apiKeyId: 'other-key',
        organizationId: 'other-org',
      })
    ).rejects.toThrow();

    expect(decide).not.toHaveBeenCalled();
  });
});
