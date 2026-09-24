import { describe, expect, it } from 'vitest';
import {
  CLEAN_FINISH_REASONS,
  DEGENERATE_FINISH_REASON,
  EARLY_STOP_FINISH_REASONS,
  TRUNCATED_FINISH_REASON,
} from '@bike4mind/common';
import {
  buildEarlyStopStamp,
  buildIncompleteAnswerNotice,
  DEGENERATE_WARNING,
  INCOMPLETE_ANSWER_NOTICE,
  TRUNCATED_ANSWER_NOTICE,
  TRUNCATION_WARNING,
} from './earlyStopStamp';

describe('buildEarlyStopStamp', () => {
  it('warns and keeps the billing row ok when the reply hit the output ceiling', () => {
    expect(buildEarlyStopStamp(TRUNCATED_FINISH_REASON)).toEqual({
      warning: TRUNCATION_WARNING,
      usageEventStatus: 'ok',
    });
  });

  it('marks a degeneration abort on the billing row so a refund sweep can find it', () => {
    // The whole point of the issue this came from: a 16-minute repetition loop was recorded
    // as an ordinary success, leaving nothing to key a refund off.
    expect(buildEarlyStopStamp(DEGENERATE_FINISH_REASON)).toEqual({
      warning: DEGENERATE_WARNING,
      usageEventStatus: 'degenerate',
    });
  });

  it('does not tell the user to continue after a degeneration abort', () => {
    // Continuing from a degenerated tail is what tends to reproduce the loop, so this copy
    // has to steer to a rephrase - unlike the truncation warning, where continuing is right.
    expect(DEGENERATE_WARNING).not.toMatch(/ask (me )?to continue/i);
    expect(DEGENERATE_WARNING).toMatch(/rephrase/i);
  });

  // The paired elision suppression keys on `isEarlyStop`, i.e. membership in
  // EARLY_STOP_FINISH_REASONS, while this module classifies reason by reason. A third
  // early-stop reason added to the set without a case here would suppress the elision
  // warning AND stamp nothing of its own - a reply with no warning at all on a row still
  // marked 'ok'. This is what pins the two together.
  it.each([...EARLY_STOP_FINISH_REASONS])('classifies every shared early-stop reason (%s)', reason => {
    expect(buildEarlyStopStamp(reason)).not.toBeNull();
  });

  it.each([...CLEAN_FINISH_REASONS])('stamps nothing on a clean finish (%s)', reason => {
    expect(buildEarlyStopStamp(reason)).toBeNull();
  });

  it.each([undefined, null, '', 'some_future_reason'])('stamps nothing for %p', reason => {
    expect(buildEarlyStopStamp(reason)).toBeNull();
  });
});

describe('buildIncompleteAnswerNotice', () => {
  const unanswered = {
    stopped: false,
    toolCallCount: 2,
    visibleCharsAfterLastToolCall: 0,
    stopReason: 'end_turn',
    producedAttachment: false,
  };

  it('flags a tool-loop turn with no visible text after its last tool call', () => {
    expect(buildIncompleteAnswerNotice(unanswered)).toBe(INCOMPLETE_ANSWER_NOTICE);
  });

  it('uses the truncation variant on max_tokens, with or without tool calls', () => {
    expect(buildIncompleteAnswerNotice({ ...unanswered, stopReason: TRUNCATED_FINISH_REASON })).toBe(
      TRUNCATED_ANSWER_NOTICE
    );
    expect(buildIncompleteAnswerNotice({ ...unanswered, toolCallCount: 0, stopReason: TRUNCATED_FINISH_REASON })).toBe(
      TRUNCATED_ANSWER_NOTICE
    );
  });

  it('stays silent when an answer was written, the turn was stopped, or no tool ran', () => {
    expect(buildIncompleteAnswerNotice({ ...unanswered, visibleCharsAfterLastToolCall: 12 })).toBeNull();
    expect(buildIncompleteAnswerNotice({ ...unanswered, stopped: true })).toBeNull();
    expect(buildIncompleteAnswerNotice({ ...unanswered, toolCallCount: 0 })).toBeNull();
  });

  it('stays silent when a tool delivered an attachment, including on max_tokens', () => {
    expect(buildIncompleteAnswerNotice({ ...unanswered, producedAttachment: true })).toBeNull();
    expect(
      buildIncompleteAnswerNotice({ ...unanswered, producedAttachment: true, stopReason: TRUNCATED_FINISH_REASON })
    ).toBeNull();
  });
});
