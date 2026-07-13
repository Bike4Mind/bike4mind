import { describe, it, expect } from 'vitest';
import { insufficientCreditsError, getQuestErrorCode } from './insufficientCredits';
import { UnprocessableEntityError, BadRequestError } from './errors';

describe('insufficientCreditsError', () => {
  it('is a 422 UnprocessableEntityError carrying the caller-supplied message', () => {
    const err = insufficientCreditsError('You do not have enough credits.');
    expect(err).toBeInstanceOf(UnprocessableEntityError);
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('You do not have enough credits.');
  });

  it('tags the error with the insufficient_credits classifier', () => {
    const err = insufficientCreditsError('out of credits');
    expect(err.additionalInfo).toEqual({ errorCode: 'insufficient_credits' });
  });
});

describe('getQuestErrorCode', () => {
  it('round-trips the classifier off an insufficientCreditsError', () => {
    expect(getQuestErrorCode(insufficientCreditsError('nope'))).toBe('insufficient_credits');
  });

  it('returns undefined for an untagged UnprocessableEntityError (e.g. a compute failure)', () => {
    expect(getQuestErrorCode(new UnprocessableEntityError('unrelated 422'))).toBeUndefined();
  });

  it('returns undefined for other error types', () => {
    expect(getQuestErrorCode(new BadRequestError('bad'))).toBeUndefined();
    expect(getQuestErrorCode(new Error('plain'))).toBeUndefined();
  });

  it('returns undefined for non-error values without throwing', () => {
    expect(getQuestErrorCode(null)).toBeUndefined();
    expect(getQuestErrorCode(undefined)).toBeUndefined();
    expect(getQuestErrorCode('string')).toBeUndefined();
    expect(getQuestErrorCode({ additionalInfo: { errorCode: 'not_a_real_code' } })).toBeUndefined();
  });
});
