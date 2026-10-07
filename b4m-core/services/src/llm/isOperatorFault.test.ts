import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  HTTPError,
  InternalServerError,
  TooManyRequestsError,
  spendCapExceededError,
} from '@bike4mind/common';
import { InsufficientCreditsError, isOperatorFault } from './ChatCompletionProcess';

describe('isOperatorFault', () => {
  it.each([
    ['a provider failure', new Error('upstream exploded')],
    ['a 5xx HTTPError', new InternalServerError('db down')],
    ['a non-Error throw', 'raw string'],
    ['a 3xx HTTPError', new HTTPError(302, 'moved')],
    ['a 500 HTTPError', new HTTPError(500, 'boom')],
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
    ['a 429 TooManyRequestsError', new TooManyRequestsError('slow down')],
    ['an overloaded provider', Object.assign(new Error('upstream busy'), { status: 529 })],
    ['the lowest 4xx status', new HTTPError(400, 'bad')],
    ['the highest 4xx status', new HTTPError(499, 'client closed')],
  ])('does not count %s', (_label, error) => {
    expect(isOperatorFault(error)).toBe(false);
  });
});
