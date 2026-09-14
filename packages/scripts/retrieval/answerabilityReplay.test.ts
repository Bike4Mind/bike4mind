import { describe, it, expect } from 'vitest';
import {
  buildAnswerabilityProbe,
  formatReplaySummary,
  selectReplayTargets,
  type ReplayRow,
} from './answerabilityReplay';

const row = (over: Partial<ReplayRow> = {}): ReplayRow => ({
  _id: 'quest1',
  prompt: 'what is our refund window',
  sessionId: 'session1',
  promptMeta: { retrieval: { mode: 'optional' } },
  ...over,
});

describe('selectReplayTargets', () => {
  it('takes the offered turns and reports why it passed over the rest', () => {
    const selection = selectReplayTargets([
      row({ _id: 'a' }),
      row({ _id: 'b', promptMeta: { retrieval: { mode: 'forced' } } }),
      row({ _id: 'c', prompt: '   ' }),
      row({ _id: 'd', sessionId: null }),
      row({ _id: 'e', promptMeta: { retrieval: { mode: 'optional', answerability: { topScore: 0.4 } } } }),
      row({ _id: 'f', promptMeta: {} }),
    ]);

    expect(selection.targets.map(target => target.questId)).toEqual(['a']);
    expect(selection.skipped).toEqual({
      not_optional: 2,
      no_prompt: 1,
      no_session: 1,
      already_probed: 1,
      // Never set here - the runner assigns it once the session is loaded.
      no_lake_scope: 0,
    });
  });

  it('leaves an already-probed turn alone by default, since a re-probe widens the drift', () => {
    const probed = row({ promptMeta: { retrieval: { mode: 'optional', answerability: { topScore: 0.4 } } } });
    expect(selectReplayTargets([probed]).targets).toHaveLength(0);
    expect(selectReplayTargets([probed], { force: true }).targets).toHaveLength(1);
  });

  it('trims the prompt it hands on, so a padded turn is not embedded with its padding', () => {
    const [target] = selectReplayTargets([row({ prompt: '  what is our refund window  ' })]).targets;
    expect(target.prompt).toBe('what is our refund window');
  });
});

describe('buildAnswerabilityProbe', () => {
  const probedAt = new Date('2026-09-11T00:00:00.000Z');

  it('reads the top score off the sorted results and counts the seam below it', () => {
    const probe = buildAnswerabilityProbe(
      [{ score: 0.91 }, { score: 0.8 }, { score: 0.75 }, { score: 0.6 }],
      { truncated: false },
      { floor: 0.75, probedAt }
    );
    expect(probe).toEqual({
      topScore: 0.91,
      // Inclusive at the floor: the same boundary the fold's cutoff uses.
      candidatesAboveFloor: 3,
      floor: 0.75,
      scanTruncated: false,
      probedAt,
    });
  });

  it('scores an empty result set with a sentinel below the valid cosine range, not zero', () => {
    // A real cosine of 0 means "something came back and matched nothing", which is a different
    // fact from "nothing came back at all" - and 0 would read as answerable under a cutoff of 0.
    const probe = buildAnswerabilityProbe([], { truncated: false }, { floor: 0.75, probedAt });
    expect(probe.topScore).toBe(-1);
    expect(probe.candidatesAboveFloor).toBe(0);
  });

  it('carries the scan truncation through, since it is what makes a low score inconclusive', () => {
    const probe = buildAnswerabilityProbe([{ score: 0.4 }], { truncated: true }, { floor: 0.75, probedAt });
    expect(probe.scanTruncated).toBe(true);
  });
});

describe('formatReplaySummary', () => {
  it('reports probed and written separately, so a dry run and a failing write path differ', () => {
    const summary = formatReplaySummary({
      probed: 10,
      written: 0,
      failed: 0,
      skipped: { not_optional: 3, no_prompt: 0, no_session: 0, already_probed: 0, no_lake_scope: 0 },
    });
    expect(summary).toContain('probed:  10');
    expect(summary).toContain('written: 0');
    expect(summary).toContain('  not_optional: 3');
    // Reasons that did not fire stay out of the block rather than padding it with zeroes.
    expect(summary).not.toContain('no_prompt');
  });
});
