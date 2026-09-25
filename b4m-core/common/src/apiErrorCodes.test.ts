import { describe, it, expect } from 'vitest';
import { API_ERROR_CODES } from './apiErrorCodes';
import { QUEST_ERROR_CODES } from './types/entities/SessionTypes';
import { TTS_ERROR_CODES, ttsErrorResponseSchema } from './voiceGeneration';
import { CompletionSseErrorEventSchema } from './schemas/cliCompletions';

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

  // The completions SSE frame is the only error surface that endpoint has (headers are
  // flushed before it prices anything, so there is no 422 to fall back to), and it
  // narrows through QUEST_ERROR_CODES - already a NARROWING_TUPLES entry, so no second
  // tuple is introduced for the same vocabulary. These pin the runtime enum, which is
  // what a caller detecting mid-stream exhaustion actually validates against.
  it('accepts every quest code through the completions SSE error frame', () => {
    for (const code of QUEST_ERROR_CODES) {
      expect(CompletionSseErrorEventSchema.safeParse({ type: 'error', message: 'nope', code }).success).toBe(true);
    }
  });

  // Absent, not empty: an unclassified crash mid-stream has no billing code to report.
  it('accepts a completions SSE error frame with no classifier', () => {
    expect(CompletionSseErrorEventSchema.safeParse({ type: 'error', message: 'boom' }).success).toBe(true);
  });

  it('rejects a completions SSE classifier outside the shared vocabulary', () => {
    expect(CompletionSseErrorEventSchema.safeParse({ type: 'error', message: 'nope', code: 'made_up' }).success).toBe(
      false
    );
  });

  // The two billing conditions have different remediations (buy credits vs raise the
  // key's cap), so the frame must be able to tell them apart rather than collapse both
  // onto one code.
  it('keeps spend_cap_exceeded distinct from insufficient_credits on the SSE frame', () => {
    const parsed = CompletionSseErrorEventSchema.parse({
      type: 'error',
      message: 'key hit its cap',
      code: 'spend_cap_exceeded',
    });
    expect(parsed.code).toBe('spend_cap_exceeded');
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
