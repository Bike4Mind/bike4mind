import { afterEach, describe, it, expect, vi } from 'vitest';
import { parseArtifactsWithFallback } from './artifactParser';
import { getReplyTruncationState, repairTruncatedArtifact } from './replyTruncation';

const OPEN_ARTIFACT = '<artifact identifier="x" type="text/html" title="Dashboard"><html><body>';

describe('getReplyTruncationState', () => {
  describe('truncated before any artifact tag (#1052)', () => {
    it('flags an empty reply that stopped at max_tokens', () => {
      // The regression: a model that spends its budget on reasoning emits nothing, so the
      // artifact-tag heuristic sees opens === 0 and the bubble renders silently blank.
      const state = getReplyTruncationState({ reply: '', completed: true, finishReason: 'max_tokens' });

      expect(state.notice).toBe('reply-empty');
      expect(state.isTruncatedArtifact).toBe(false);
    });

    it('treats a whitespace-only reply as empty', () => {
      const state = getReplyTruncationState({ reply: '\n  \n', completed: true, finishReason: 'max_tokens' });

      expect(state.notice).toBe('reply-empty');
    });

    it('flags prose that stopped mid-sentence at max_tokens', () => {
      const state = getReplyTruncationState({
        reply: 'Here are the top 100 languages. 1. TypeScript - strong typing, huge ecosystem, and',
        completed: true,
        finishReason: 'max_tokens',
      });

      expect(state.notice).toBe('reply-partial');
      expect(state.isTruncatedArtifact).toBe(false);
    });
  });

  describe('truncated mid-artifact (pre-existing behaviour)', () => {
    it('keeps the artifact notice when the opening tag was emitted', () => {
      const state = getReplyTruncationState({
        reply: `Building it now.\n${OPEN_ARTIFACT}`,
        completed: true,
        finishReason: 'max_tokens',
      });

      expect(state.notice).toBe('artifact');
      expect(state.isTruncatedArtifact).toBe(true);
    });

    it('detects a dangling second artifact after a closed first one', () => {
      const state = getReplyTruncationState({
        reply: `${OPEN_ARTIFACT}</artifact>\nAnd the second:\n${OPEN_ARTIFACT}`,
        completed: true,
        finishReason: 'max_tokens',
      });

      expect(state.notice).toBe('artifact');
    });

    it('contains an unclosed artifact on an unrecognized stop reason', () => {
      // stopReason.ts passes unrecognized provider values (e.g. OpenAI Responses'
      // 'content_filter') through unchanged precisely so they stay OUT of
      // CLEAN_FINISH_REASONS and still reach containment - see stopReasonBackends.test.ts.
      const state = getReplyTruncationState({
        reply: OPEN_ARTIFACT,
        completed: true,
        finishReason: 'content_filter',
      });

      expect(state.isTruncatedArtifact).toBe(true);
      expect(state.notice).toBe('artifact');
    });

    it('contains an unclosed artifact when no finishReason was recorded', () => {
      // Older quests / backends that report no stop reason: still contain the partial so raw
      // HTML cannot leak, but do not claim a plain truncation.
      const state = getReplyTruncationState({ reply: OPEN_ARTIFACT, completed: true });

      expect(state.isTruncatedArtifact).toBe(true);
      expect(state.notice).toBe('artifact');
    });
  });

  describe('replies that must not be reported as truncated', () => {
    it.each(['end_turn', 'stop', 'tool_use', 'stop_sequence'])('ignores a prose mention on %s', finishReason => {
      const state = getReplyTruncationState({
        reply: 'Wrap the code in an `<artifact` tag to make it previewable.',
        completed: true,
        finishReason,
      });

      expect(state.notice).toBeNull();
      expect(state.isTruncatedArtifact).toBe(false);
    });

    it('stays silent on a complete reply with a closed artifact', () => {
      const state = getReplyTruncationState({
        reply: `${OPEN_ARTIFACT}</artifact>`,
        completed: true,
        finishReason: 'end_turn',
      });

      expect(state.notice).toBeNull();
    });

    it('claims no truncation on an unrecognized stop reason with no artifact tag', () => {
      // Only max_tokens means "cut off at the output ceiling". A content-filtered or
      // otherwise unknown stop must not be reported as a length truncation.
      const state = getReplyTruncationState({ reply: '', completed: true, finishReason: 'content_filter' });

      expect(state.notice).toBeNull();
    });

    it('stays silent on a completed reply with no finishReason at all', () => {
      const state = getReplyTruncationState({ reply: 'All done.', completed: true });

      expect(state.notice).toBeNull();
    });
  });

  describe('still streaming', () => {
    it('reports a streaming artifact and no notice', () => {
      const state = getReplyTruncationState({ reply: OPEN_ARTIFACT, completed: false });

      expect(state.isStreamingArtifact).toBe(true);
      expect(state.isTruncatedArtifact).toBe(false);
      expect(state.notice).toBeNull();
    });

    it('does not announce truncation before the quest completes', () => {
      // finishReason can only arrive with the finished quest, but guard the ordering anyway.
      const state = getReplyTruncationState({ reply: '', completed: false, finishReason: 'max_tokens' });

      expect(state.notice).toBeNull();
    });
  });
});

describe('degenerate-repetition stop reason', () => {
  // Regression for the PR #1427 review: `degenerate_repetition` sits outside
  // CLEAN_FINISH_REASONS, but that set only feeds the ARTIFACT branch. The prose
  // branch used to require an exact 'max_tokens', so an aborted degenerate stream
  // with no unclosed artifact - the common case - surfaced no notice at all.
  it('surfaces a distinct notice when a reply was stopped for repeating itself', () => {
    const state = getReplyTruncationState({
      reply: 'Here is the module. ' + '</invoke>\n'.repeat(50),
      completed: true,
      finishReason: 'degenerate_repetition',
    });

    expect(state.notice).toBe('reply-degenerate');
  });

  it('keeps the ceiling notice distinct from the degeneration notice', () => {
    expect(
      getReplyTruncationState({ reply: 'partial prose', completed: true, finishReason: 'max_tokens' }).notice
    ).toBe('reply-partial');
  });

  it('still surfaces nothing when no finish reason is reported', () => {
    // The property the original exact-match comment was protecting: pre-existing
    // quests with no finishReason must not grow a false banner.
    expect(getReplyTruncationState({ reply: 'some prose', completed: true }).notice).toBeNull();
  });
});

describe('repairTruncatedArtifact', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes an artifact whose opening tag arrived whole, so the partial parses', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repaired = repairTruncatedArtifact('Intro <artifact identifier="a" type="text/html" title="P">\n<div>');

    expect(repaired.endsWith('\n</artifact>')).toBe(true);
    const { artifacts, cleanedContent } = parseArtifactsWithFallback(repaired);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ identifier: 'a', type: 'html', content: '<div>' });
    expect(cleanedContent).toBe('Intro');
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a tail whose opening tag was cut mid-attribute, and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tail = '<artifact identifier="a" type="text/ht';

    expect(repairTruncatedArtifact(`Intro ${tail}`)).toBe('Intro');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`(${tail.length} chars)`);
  });

  it('targets only the last opener, leaving an earlier closed artifact intact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closed = '<artifact identifier="first" type="text/html" title="One"><p>one</p></artifact>';

    const repaired = repairTruncatedArtifact(`${closed}\nMore <artifact identifier="second" type="text/ht`);
    expect(repaired).toBe(`${closed}\nMore`);
    expect(parseArtifactsWithFallback(repaired).artifacts.map(a => a.identifier)).toEqual(['first']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('closes only the dangling artifact after a closed one, trimming trailing whitespace first', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closed = '<artifact identifier="first" type="text/html" title="One"><p>one</p></artifact>';
    const dangling = '<artifact identifier="second" type="text/html" title="Two">\n<div>';

    const repaired = repairTruncatedArtifact(`${closed}\n${dangling}  \n`);
    expect(repaired).toBe(`${closed}\n${dangling}\n</artifact>`);
    const ids = parseArtifactsWithFallback(repaired).artifacts.map(a => a.identifier);
    expect(ids.sort()).toEqual(['first', 'second']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns content with no opener unchanged, logging a zero-length drop', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(repairTruncatedArtifact('Intro with no artifact ')).toBe('Intro with no artifact ');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('(0 chars)');
  });

  it('treats a ">" inside a quoted attribute value as part of an incomplete tag', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(repairTruncatedArtifact('Intro <artifact identifier="a" type="text/html" title="A -> B')).toBe('Intro');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
