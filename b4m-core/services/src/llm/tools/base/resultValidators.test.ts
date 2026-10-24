import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStructuredResultValidator } from './resultValidators';

describe('createStructuredResultValidator', () => {
  const validate = createStructuredResultValidator(z.object({ total: z.number() }));

  it('has no opinion on JSON that matches the schema', () => {
    expect(validate(JSON.stringify({ total: 3 }))).toBeUndefined();
  });

  it.each([
    ['JSON that fails the schema', JSON.stringify({ total: 'three' })],
    ['output that is not JSON', 'total: 3'],
  ])('scores %s as a failure', (_label, result) => {
    expect(validate(result)).toEqual({ confidence: 0.1, source: 'deterministic' });
  });
});
