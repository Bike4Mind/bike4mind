import { describe, it, expect } from 'vitest';
import { isDuplicateKeyError } from './isDuplicateKeyError';

/**
 * Seven unrelated handlers turn a `true` here into a 400 instead of a 500, and `verifyCallback`
 * turns it into `duplicate_account`. So the message arm has to match the driver's actual phrase
 * and not merely the code that appears inside it - a cast or validation failure that happens to
 * quote `E11000` must keep travelling the generic failure path.
 */
describe('isDuplicateKeyError', () => {
  it('matches the structural code, whatever the error class', () => {
    expect(isDuplicateKeyError(Object.assign(new Error('boom'), { code: 11000 }))).toBe(true);
    // A driver error that crossed a serialization boundary arrives as a plain object.
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
  });

  it('matches the driver phrase when the code did not survive', () => {
    expect(
      isDuplicateKeyError({
        message: 'E11000 duplicate key error collection: test.feedback index: feedback_helpContext_eventId',
      })
    ).toBe(true);
  });

  it('does not classify an unrelated failure that merely quotes the code', () => {
    expect(isDuplicateKeyError(new Error('Cast to ObjectId failed for value "E11000" at path "_id"'))).toBe(false);
    expect(isDuplicateKeyError(new Error('index E11000 rebuild aborted'))).toBe(false);
  });

  it('rejects everything that is not an error-shaped object', () => {
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError('E11000 duplicate key error')).toBe(false);
    expect(isDuplicateKeyError({ code: 11001 })).toBe(false);
  });
});
