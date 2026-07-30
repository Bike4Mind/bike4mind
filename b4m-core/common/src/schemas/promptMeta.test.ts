import { describe, it, expect } from 'vitest';
import { PromptMetaZodSchema } from './promptMeta';
import { ArtifactTypeSchema } from '../types/entities/ArtifactTypes';

// ChatCompletionInvoke runs PromptMetaZodSchema.parse(quest.promptMeta) on every turn, so a
// value this schema rejects fails the completion outright. These cover the fields whose real
// runtime values are wider than a naive reading of the schema suggests.
describe('PromptMetaZodSchema artifact types', () => {
  it.each(ArtifactTypeSchema.options)('accepts the %s artifact type that parseArtifacts emits', type => {
    const parsed = PromptMetaZodSchema.parse({
      artifacts: [{ type, content: '<div />' }],
    });

    expect(parsed.artifacts?.[0]?.type).toBe(type);
  });

  it('accepts a raw MIME type, which tool extraction falls back to', () => {
    const parsed = PromptMetaZodSchema.parse({
      artifacts: [{ type: 'application/vnd.ant.chess', content: '{}' }],
    });

    expect(parsed.artifacts?.[0]?.type).toBe('application/vnd.ant.chess');
  });
});
