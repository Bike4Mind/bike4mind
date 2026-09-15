import { describe, it, expect } from 'vitest';
import {
  CLEAN_FINISH_REASONS,
  DEGENERATE_FINISH_REASON,
  EARLY_STOP_FINISH_REASONS,
  TRUNCATED_FINISH_REASON,
  isEarlyStop,
} from './stopReasons';

describe('isEarlyStop', () => {
  it('flags a reply cut off at the output-token ceiling', () => {
    expect(isEarlyStop(TRUNCATED_FINISH_REASON)).toBe(true);
  });

  it('flags a stream we aborted for degenerating into repetition', () => {
    expect(isEarlyStop(DEGENERATE_FINISH_REASON)).toBe(true);
  });

  it.each([...CLEAN_FINISH_REASONS])('treats %s as a clean finish', reason => {
    expect(isEarlyStop(reason)).toBe(false);
  });

  // Absence is common and benign (older servers, backends that report nothing, interim
  // chunks). Treating it as truncation would put a warning on almost every reply.
  it('does not treat a missing reason as an early stop', () => {
    expect(isEarlyStop(undefined)).toBe(false);
    expect(isEarlyStop(null)).toBe(false);
    expect(isEarlyStop('')).toBe(false);
  });

  // An unknown value is not guessed at in either direction: it is not an early stop here,
  // while the client's artifact-containment path separately treats "not clean" as suspect.
  it('does not treat an unrecognized reason as an early stop', () => {
    expect(isEarlyStop('some_future_reason')).toBe(false);
  });
});

describe('stop reason vocabulary', () => {
  it('keeps the clean and early-stop sets disjoint', () => {
    for (const reason of EARLY_STOP_FINISH_REASONS) {
      expect(CLEAN_FINISH_REASONS.has(reason)).toBe(false);
    }
  });

  it('covers every early-stop reason with isEarlyStop', () => {
    for (const reason of EARLY_STOP_FINISH_REASONS) {
      expect(isEarlyStop(reason)).toBe(true);
    }
  });
});
