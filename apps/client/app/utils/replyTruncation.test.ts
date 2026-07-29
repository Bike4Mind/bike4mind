import { describe, it, expect } from 'vitest';
import { getReplyTruncationState } from './replyTruncation';

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
