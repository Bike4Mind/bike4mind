import { describe, it, expect } from 'vitest';
import { EditImageRequestBodySchema, GenerateImageIvokeParamsSchema } from './llm';
import { MAX_REFERENCE_IMAGES } from './utils/modelHelpers';

describe('referenceImageFabFileIds cap', () => {
  const ids = (count: number) => Array.from({ length: count }, (_, i) => `f${i}`);
  // Only the reference field is under test; other required fields may still fail.
  const refIssues = (schema: typeof GenerateImageIvokeParamsSchema | typeof EditImageRequestBodySchema, n: number) =>
    (schema.safeParse({ referenceImageFabFileIds: ids(n) }).error?.issues ?? []).filter(
      issue => issue.path[0] === 'referenceImageFabFileIds'
    );

  it("is OpenAI's documented limit of 16", () => {
    expect(MAX_REFERENCE_IMAGES).toBe(16);
  });

  it.each([
    ['generate', GenerateImageIvokeParamsSchema],
    ['edit', EditImageRequestBodySchema],
  ] as const)('%s accepts 16 references and rejects 17', (_, schema) => {
    expect(refIssues(schema, 16)).toEqual([]);
    expect(refIssues(schema, 17)).toHaveLength(1);
  });
});
