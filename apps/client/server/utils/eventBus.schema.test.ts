/**
 * Event payload schemas, exercised against the REAL module. `session.summarize` carries the
 * trigger that ends up on `ISession.summaryTrigger`, and this `parse` is the only validator
 * standing between a publisher and a stored value: BaseModel's findOneAndUpdate writes without
 * runValidators, so the Mongoose enum never runs on the summarization handler's write path.
 * It names PERSISTED_SESSION_SUMMARY_TRIGGERS, not the full union - see sessionSummary.ts.
 * Every handler test mocks this schema away, which is why it needs a home of its own.
 */

import { describe, expect, it } from 'vitest';
import { PERSISTED_SESSION_SUMMARY_TRIGGERS } from '@bike4mind/common';
import { SessionEvents } from './eventBus';

describe('SessionEvents.Summarize.schema', () => {
  it.each([...PERSISTED_SESSION_SUMMARY_TRIGGERS])('accepts the %s trigger', trigger => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1', trigger });
    expect(result.success).toBe(true);
  });

  // 'milestone' and 'growth' are the two values the Mongoose enum used to accept and nothing ever
  // produced; a publisher sending either must be stopped here or it reaches the document.
  it.each(['milestone', 'growth'])('rejects %s, a trigger outside the list', trigger => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1', trigger });
    expect(result.success).toBe(false);
  });

  /**
   * 'throttling' is in SessionSummaryTrigger but names a summarization that was DECLINED, so it
   * describes no run and must not be stampable. Rejecting it here is what keeps it out of the
   * document, and therefore out of the copy paths that read provenance back off one.
   */
  it('rejects throttling, which names a decision not to summarize', () => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1', trigger: 'throttling' });
    expect(result.success).toBe(false);
  });

  /**
   * Omission is rejected too: the handler writes through $set, which drops an undefined, so an
   * event with no trigger would leave a fresh summary beside the PREVIOUS run's provenance.
   */
  it('rejects a payload that omits the trigger', () => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1' });
    expect(result.success).toBe(false);
  });
});
