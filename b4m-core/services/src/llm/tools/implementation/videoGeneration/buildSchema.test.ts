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

  type OptionEnums = { properties: { aspectRatio: { enum: string[] }; resolution: { enum: string[] } } };

  it('offers only the aspect ratios and resolutions of the one usable model', () => {
    const { schema } = buildVideoToolSchema(['test-video']);
    const jsonSchema = z.toJSONSchema(schema) as OptionEnums;
    expect(jsonSchema.properties.aspectRatio.enum).toEqual(['16:9', '9:16']);
    expect(jsonSchema.properties.resolution.enum).toEqual(['720p']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', aspectRatio: '1:1' }).success).toBe(false);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', resolution: '480p' }).success).toBe(false);
  });

  it('offers the union of aspect ratios and resolutions across usable models in catalog order', () => {
    const { schema } = buildVideoToolSchema(['grok-imagine-video-1.5', 'test-video']);
    const jsonSchema = z.toJSONSchema(schema) as OptionEnums;
    expect(jsonSchema.properties.aspectRatio.enum).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']);
    expect(jsonSchema.properties.resolution.enum).toEqual(['480p', '720p']);
    expect(schema.safeParse({ model: 'test-video', prompt: 'x', resolution: '480p' }).success).toBe(true);
  });
});
