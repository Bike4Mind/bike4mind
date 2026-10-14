import { describe, it, expect } from 'vitest';
import {
  ChatCompletionInvokeParamsSchema,
  EditImageRequestBodySchema,
  GenerateImageIvokeParamsSchema,
  LLMApiRequestBodySchema,
} from './llm';
import { MAX_REFERENCE_IMAGES } from './utils/modelHelpers';

describe('referenceImageFabFileIds cap', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);
  // Only the reference field is under test; other required fields may still fail.
  const refIssues = (schema: typeof GenerateImageIvokeParamsSchema | typeof EditImageRequestBodySchema, n: number) =>
    (schema.safeParse({ referenceImageFabFileIds: ids(n) }).error?.issues ?? []).filter(
      issue => issue.path[0] === 'referenceImageFabFileIds'
    );

  it("leaves room for the primary image within OpenAI's documented limit of 16", () => {
    expect(MAX_REFERENCE_IMAGES).toBe(15);
  });

  it.each([
    ['generate', GenerateImageIvokeParamsSchema],
    ['edit', EditImageRequestBodySchema],
  ] as const)('%s accepts 15 references and rejects 16', (_, schema) => {
    expect(refIssues(schema, 15)).toEqual([]);
    expect(refIssues(schema, 16)).toHaveLength(1);
  });
});

describe('LLMApiRequestBodySchema toolMode fence', () => {
  const body = {
    sessionId: 'session-1',
    historyCount: 0,
    fabFileIds: [],
    message: 'hi',
    params: { model: 'gpt-4o' },
    toolMode: 'smart',
  };

  it('strips toolMode so an in-app turn cannot be attributed to a public /api/chat mode', () => {
    expect(ChatCompletionInvokeParamsSchema.parse(body)).toHaveProperty('toolMode', 'smart');
    expect(LLMApiRequestBodySchema.parse(body)).not.toHaveProperty('toolMode');
  });
});
