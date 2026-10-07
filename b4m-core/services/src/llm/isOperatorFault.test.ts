import { describe, expect, it } from 'vitest';
import { BadRequestError, InternalServerError, spendCapExceededError } from '@bike4mind/common';
import { InsufficientCreditsError, isOperatorFault } from './ChatCompletionProcess';

describe('isOperatorFault', () => {
  it.each([
    ['a provider failure', new Error('upstream exploded')],
    ['a 5xx HTTPError', new InternalServerError('db down')],
    ['a non-Error throw', 'raw string'],
  ])('counts %s', (_label, error) => {
    expect(isOperatorFault(error)).toBe(true);
  });

  it.each([
    ['an insufficient-credits error', new InsufficientCreditsError('out', 'insufficient_credits')],
    ['a tagged spend-cap 422', spendCapExceededError('cap hit')],
    ['an AbortError', new DOMException('The operation was aborted', 'AbortError')],
    ['an SDK abort message', new Error('Request was aborted.')],
    ['a request timeout', new Error('request timeout after 60000ms')],
    ['a stream idle timeout', new Error('stream timeout')],
    ['a tool pairing error', new Error('tool_use ids must have a matching tool_result')],
    ['a context overflow', new Error('Your request is too large for this model')],
    ['a caller-input 4xx', new BadRequestError('Failed to create LLM backend for model: nope')],
  ])('does not count %s', (_label, error) => {
    expect(isOperatorFault(error)).toBe(false);
  });
});
