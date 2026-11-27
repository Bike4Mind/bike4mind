import { describe, expect, it } from 'vitest';
import { CreateMementoSchema, UpdateMementoSchema } from './mementoValidators';

const base = { type: 'prompt', tier: 'hot', weight: 500, summary: 'qa check', sessionId: 's1' };

describe('CreateMementoSchema', () => {
  it('rejects a missing, empty or whitespace-only fullContent, which the model would refuse', () => {
    expect(CreateMementoSchema.safeParse(base).success).toBe(false);
    expect(CreateMementoSchema.safeParse({ ...base, fullContent: '' }).success).toBe(false);
    expect(CreateMementoSchema.safeParse({ ...base, fullContent: '   ' }).success).toBe(false);
  });

  it('accepts a non-empty fullContent', () => {
    expect(CreateMementoSchema.parse({ ...base, fullContent: 'body' }).fullContent).toBe('body');
  });
});

describe('UpdateMementoSchema', () => {
  it('keeps fullContent optional and unconstrained', () => {
    expect(UpdateMementoSchema.parse({}).fullContent).toBeUndefined();
    expect(UpdateMementoSchema.parse({ fullContent: '' }).fullContent).toBe('');
  });
});
