import { describe, expect, it } from 'vitest';
import { describeMementoValidationError } from './mementoModelValidation';

const validationError = (errors?: Record<string, unknown>) =>
  Object.assign(new Error('Memento validation failed'), { name: 'ValidationError', errors });

describe('describeMementoValidationError', () => {
  it('names every failing path', () => {
    expect(describeMementoValidationError(validationError({ fullContent: {}, summary: {} }))).toBe(
      'Invalid memento: fullContent, summary'
    );
  });

  it('falls back when the error carries no paths', () => {
    expect(describeMementoValidationError(validationError())).toBe('Invalid memento: validation failed');
  });

  it('ignores any other error', () => {
    expect(describeMementoValidationError(new Error('boom'))).toBeUndefined();
    expect(describeMementoValidationError('ValidationError')).toBeUndefined();
  });
});
