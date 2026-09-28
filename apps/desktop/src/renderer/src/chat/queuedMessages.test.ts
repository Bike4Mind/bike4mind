import type { ChatQueueEvent, ChatQueuedMessage } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { describeReturn, mergeIntoDraft, queuedPreview } from './queuedMessages';

function queued(text: string, id = 'q1'): ChatQueuedMessage {
  return { id, sessionId: 's1', text, queuedAt: '2026-01-01T00:00:00.000Z' };
}

describe('mergeIntoDraft', () => {
  it('fills an empty composer with the returned text', () => {
    expect(mergeIntoDraft('', [queued('hold on')])).toBe('hold on');
    expect(mergeIntoDraft('   \n ', [queued('hold on')])).toBe('hold on');
  });

  // The rule that keeps a cancel from destroying work: two things the user wrote, both kept.
  it('appends rather than replacing what is already being typed', () => {
    expect(mergeIntoDraft('half a thought', [queued('hold on')])).toBe('half a thought\nhold on');
  });

  it('keeps several returned messages in the order they were queued', () => {
    expect(mergeIntoDraft('', [queued('one', 'a'), queued('two', 'b')])).toBe('one\ntwo');
  });

  it('leaves the draft alone when there is nothing to give back', () => {
    expect(mergeIntoDraft('typing', [])).toBe('typing');
    expect(mergeIntoDraft('typing', [queued('   ')])).toBe('typing');
  });
});

describe('describeReturn', () => {
  const event = (reason: NonNullable<ChatQueueEvent['returned']>['reason'], count = 1, detail?: string) => ({
    messages: Array.from({ length: count }, (_, index) => queued(`m${index}`, `q${index}`)),
    reason,
    ...(detail ? { detail } : {}),
  });

  // Cancelling is the user's own doing; the text landing back under their cursor says it all.
  it('says nothing when the user cancelled it themselves', () => {
    expect(describeReturn(event('cancelled'))).toBeNull();
  });

  it('explains a stop, which the user may not connect to their queued message', () => {
    expect(describeReturn(event('stopped'))).toMatch(/stopped the reply.*was not sent.*back in the composer/i);
  });

  it('explains a failed reply', () => {
    expect(describeReturn(event('failed'))).toMatch(/failed.*was not sent/i);
  });

  it('quotes the refusal when the turn itself was refused', () => {
    expect(describeReturn(event('refused', 1, 'Sign in to send a message.'))).toMatch(/Sign in to send a message\./);
  });

  it('agrees in number with what came back', () => {
    expect(describeReturn(event('stopped', 2))).toMatch(/your 2 queued messages were not sent\. They are back/i);
  });

  it('says nothing when nothing came back', () => {
    expect(describeReturn(undefined)).toBeNull();
    expect(describeReturn(event('stopped', 0))).toBeNull();
  });
});

describe('queuedPreview', () => {
  it('flattens newlines so one row stays one row', () => {
    expect(queuedPreview(queued('first\n\nsecond'))).toBe('first second');
  });

  it('clips a pasted wall of text', () => {
    const preview = queuedPreview(queued('x'.repeat(400)));
    expect(preview.endsWith('...')).toBe(true);
    expect(preview.length).toBeLessThan(200);
  });

  // An attachment with no prose is a real turn, so the row still has to say something.
  it('names an attachment-only message', () => {
    expect(queuedPreview(queued(''))).toBe('(attachments only)');
  });
});
