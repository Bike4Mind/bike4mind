import { describe, it, expect } from 'vitest';
import { API_ERROR_CODES } from './apiErrorCodes';
import { QUEST_ERROR_CODES } from './types/entities/SessionTypes';
import { TTS_ERROR_CODES, ttsErrorResponseSchema } from './voiceGeneration';

/**
 * The `satisfies readonly ApiErrorCode[]` on each narrowing tuple is what actually
 * enforces "one vocabulary" (CONVENTIONS.md section 1) - a code missing from
 * `API_ERROR_CODES` fails to compile, so there is nothing left for a test to catch.
 *
 * These cover the two things the compiler cannot: that the shared union is not
 * carrying entries no endpoint emits (dead published vocabulary), and that the
 * runtime Zod enum a caller is validated against really accepts the codes the
 * handler sends.
 */
describe('API_ERROR_CODES', () => {
  it('has no duplicate entries', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  // Every shared code must be reachable from some published surface, or it is a
  // classifier we document and never send. `response_too_large` was exactly that
  // before it was dropped: named in the status table, emitted by nothing.
  //
  // NOTE: the narrowing tuples cannot be enumerated (there is no registry of them),
  // so this list is hand-maintained. Adding a new narrowing tuple elsewhere means
  // adding it HERE too - which is the point: a code with no surface should have to
  // justify itself rather than sit in the published vocabulary unemitted.
  it('carries no code that no surface emits', () => {
    const NARROWING_TUPLES = [QUEST_ERROR_CODES, TTS_ERROR_CODES];
    const emitted = new Set<string>(NARROWING_TUPLES.flat());
    expect(API_ERROR_CODES.filter(code => !emitted.has(code))).toEqual([]);
  });

  it('accepts every TTS code through the published TTS error schema', () => {
    for (const code of TTS_ERROR_CODES) {
      expect(ttsErrorResponseSchema.safeParse({ error: 'nope', errorCode: code }).success).toBe(true);
    }
  });

  // The classifier is optional: a validation 422 shares the status with the
  // credits 422 and is distinguished by having no errorCode at all.
  it('accepts a TTS error body with no classifier', () => {
    expect(ttsErrorResponseSchema.safeParse({ error: 'bad body' }).success).toBe(true);
  });

  it('rejects a classifier outside the shared vocabulary', () => {
    expect(ttsErrorResponseSchema.safeParse({ error: 'nope', errorCode: 'made_up' }).success).toBe(false);
  });
});
