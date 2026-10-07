import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildVideoToolSchema } from './buildSchema';

describe('buildVideoToolSchema', () => {
  it('only accepts usable models', () => {
    const { schema } = buildVideoToolSchema(['test-video']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'a cat' }).success).toBe(true);
    expect(schema.safeParse({ model: 'veo-3.1-fast-generate-preview', prompt: 'a cat' }).success).toBe(false);
  });

  it('spans the duration bounds of every usable model', () => {
    const { schema } = buildVideoToolSchema(['test-video', 'veo-3.1-fast-generate-preview']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', durationSeconds: 10 }).success).toBe(true);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', durationSeconds: 11 }).success).toBe(false);
  });

  it('describes each model with its render time', () => {
    const { description } = buildVideoToolSchema(['test-video']);
    expect(description).toContain('test-video');
    expect(description).toContain('about 8s');
  });

  it('documents inputImageFileId as an uploaded file id', () => {
    const { schema } = buildVideoToolSchema(['test-video']);
    expect(schema.shape.inputImageFileId.description).toMatch(/uploaded/i);
  });

  it('converts to JSON Schema with the usable model ids as the model enum', () => {
    const { schema } = buildVideoToolSchema(['test-video', 'grok-imagine-video-1.5']);
    const jsonSchema = z.toJSONSchema(schema) as { properties: { model: { enum: string[] } } };
    expect(jsonSchema.properties.model.enum).toEqual(['test-video', 'grok-imagine-video-1.5']);
  });
});
