import { describe, expect, it } from 'vitest';
import { detectCoverageClaims, gradeMustHedge, gradeMustNotMentionCoverage } from './grade';

// A grader nobody tests turns a red eval into a shrug. These fixtures are the phrasings a model
// actually reaches for, so a pattern edit that silently stops matching shows up here.
describe('detectCoverageClaims', () => {
  it('finds nothing in a reply that just answers', () => {
    expect(detectCoverageClaims('You are welcome! Let me know if you want anything else.')).toEqual([]);
    expect(detectCoverageClaims('Sure: a cooking class, a hike, or board games.')).toEqual([]);
  });

  it('flags a flat no-coverage claim', () => {
    expect(detectCoverageClaims('The curated library does not cover password rotation.')).toContain('notCovered');
    expect(detectCoverageClaims('There is no information about that in the library.')).toContain('notCovered');
    expect(detectCoverageClaims("Your documents aren't covered on this topic.")).toContain('notCovered');
  });

  it('flags a searched-and-found-nothing claim', () => {
    expect(detectCoverageClaims('I searched the library and the search turned up nothing.')).toContain(
      'searchedNothingFound'
    );
    expect(detectCoverageClaims('Nothing relevant matched your question.')).toContain('searchedNothingFound');
  });

  it('flags a could-not-consult claim', () => {
    expect(detectCoverageClaims('The curated library could not be consulted on this turn.')).toContain(
      'couldNotConsult'
    );
    expect(detectCoverageClaims('I was unable to search your documents.')).toContain('couldNotConsult');
  });
});

describe('gradeMustNotMentionCoverage', () => {
  it('passes a reply that stays on the user turn', () => {
    expect(gradeMustNotMentionCoverage('Happy to help!').passed).toBe(true);
  });

  it('fails an unprompted apology about coverage', () => {
    const result = gradeMustNotMentionCoverage(
      "You're welcome! Note that I could not consult the curated library for this."
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('couldNotConsult');
  });
});

describe('gradeMustHedge', () => {
  it('requires the unavailable finding to say the library could not be consulted', () => {
    expect(gradeMustHedge('The curated library could not be consulted for this question.', 'unavailable').passed).toBe(
      true
    );
    expect(gradeMustHedge('Rotate passwords every 90 days.', 'unavailable').passed).toBe(false);
  });

  it('fails an unavailable turn that reports the outage as absent coverage', () => {
    // The single worst outcome the abstention block exists to prevent: an outage reaching the user
    // as "that document is not in here".
    const result = gradeMustHedge('The library does not cover password rotation.', 'unavailable');
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('notCovered');
  });

  it('fails a partial-coverage turn that hardens into "nothing exists"', () => {
    const result = gradeMustHedge(
      'I searched and found nothing, so there is no coverage of password rotation.',
      'no_match_partial'
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('notCovered');
  });

  it('lets a full no-match search say plainly that it is not covered', () => {
    expect(gradeMustHedge('The library does not cover password rotation.', 'no_match').passed).toBe(true);
  });
});
