import { describe, it, expect } from 'vitest';
import { ANNOTATION_ANCHOR_TEXT_MAX, CreateAnnotationRequestSchema } from './annotation';

const parse = (anchor?: unknown) => CreateAnnotationRequestSchema.safeParse({ body: 'hi', anchor });

describe('annotation anchor elementText', () => {
  it('accepts text up to the cap', () => {
    const elementText = 'a'.repeat(ANNOTATION_ANCHOR_TEXT_MAX);
    expect(parse({ x: 0.1, y: 0.2, elementText })).toMatchObject({ success: true });
  });

  it('rejects text over the cap or of the wrong type', () => {
    expect(parse({ elementText: 'a'.repeat(ANNOTATION_ANCHOR_TEXT_MAX + 1) }).success).toBe(false);
    expect(parse({ elementText: 123 }).success).toBe(false);
  });

  it('still accepts a legacy anchor and no anchor', () => {
    expect(parse({ x: 0.1, y: 0.2 }).success).toBe(true);
    expect(parse(undefined).success).toBe(true);
  });
});
