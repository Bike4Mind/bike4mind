import { describe, it, expect } from 'vitest';
import { SessionUpdateRequestSchema, SessionIdParamSchema, SessionResponseSchema } from './session';

describe('SessionUpdateRequestSchema', () => {
  it('accepts an empty body (every field optional - a caller can update just one thing)', () => {
    expect(SessionUpdateRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts knowledgeIds + forceKnowledgeRetrieval together (the grounded-retrieval call)', () => {
    const result = SessionUpdateRequestSchema.safeParse({
      knowledgeIds: ['fab_1', 'fab_2'],
      forceKnowledgeRetrieval: true,
    });
    expect(result.success).toBe(true);
  });

  it.each([null, undefined])(
    'accepts lastUsedModel: %p (both mean "leave unchanged", matching the service fallback)',
    value => {
      const result = SessionUpdateRequestSchema.safeParse({ lastUsedModel: value });
      expect(result.success).toBe(true);
    }
  );

  it('strips an unrecognized field rather than erroring - id is addressed via the URL path, not the body', () => {
    const result = SessionUpdateRequestSchema.safeParse({ id: 'sess_1', name: 'renamed' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('id');
  });

  it('rejects a wrong-typed field instead of coercing it', () => {
    expect(SessionUpdateRequestSchema.safeParse({ forceKnowledgeRetrieval: 'true' }).success).toBe(false);
  });
});

describe('SessionIdParamSchema', () => {
  it('requires id', () => {
    expect(SessionIdParamSchema.safeParse({}).success).toBe(false);
  });

  it('parses req.query-shaped input, ignoring any real query-string keys alongside it', () => {
    const result = SessionIdParamSchema.safeParse({ id: 'sess_1', unrelatedQueryParam: 'x' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ id: 'sess_1' });
  });
});

describe('SessionResponseSchema', () => {
  const base = { id: 'sess_1', name: 'Untitled', userId: 'user_1', firstCreated: new Date(), lastUpdated: new Date() };

  it('requires firstCreated/lastUpdated as real Date instances (ISession never leaves them unset)', () => {
    expect(SessionResponseSchema.safeParse(base).success).toBe(true);
    expect(SessionResponseSchema.safeParse({ ...base, firstCreated: undefined }).success).toBe(false);
  });

  it('rejects a null date rather than silently coercing it (unlike z.coerce.date(), which would accept null)', () => {
    expect(SessionResponseSchema.safeParse({ ...base, firstCreated: null }).success).toBe(false);
  });
});
