/**
 * Event payload schemas, exercised against the REAL module. `session.summarize` carries the
 * trigger that ends up on `ISession.summaryTrigger`, and this `parse` is the only validator
 * standing between a publisher and a stored value: BaseModel's findOneAndUpdate writes without
 * runValidators, so the Mongoose enum never runs on the summarization handler's write path.
 * Every handler test mocks this schema away, which is why it needs a home of its own.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_SUMMARY_TRIGGERS } from '@bike4mind/common';
import { SessionEvents } from './eventBus';

describe('SessionEvents.Summarize.schema', () => {
  it.each([...SESSION_SUMMARY_TRIGGERS])('accepts the %s trigger', trigger => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1', trigger });
    expect(result.success).toBe(true);
  });

  // 'milestone' and 'growth' are the two values the Mongoose enum used to accept and nothing ever
  // produced; a publisher sending either must be stopped here or it reaches the document.
  it.each(['milestone', 'growth'])('rejects %s, a trigger outside the list', trigger => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1', trigger });
    expect(result.success).toBe(false);
  });

  // Optional by design: the completion and image paths publish without one, and the handler sends
  // the key through as undefined rather than inventing a value.
  it('accepts a payload that omits the trigger', () => {
    const result = SessionEvents.Summarize.schema.safeParse({ sessionId: 's1' });
    expect(result.success).toBe(true);
  });
});
