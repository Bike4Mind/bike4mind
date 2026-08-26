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

  it('does not read an absence scoped to the speaker as a claim about the corpus', () => {
    // The distinction the whole grader turns on: "I have no information" is a statement about the
    // model on this turn, "there is no information in the library" is a claim about the corpus, and
    // only the second is what `unavailable` never earns. Every fixture here is a reply doing exactly
    // what FORCED_RETRIEVAL_NO_CONTEXT_RULES asks for on an outage.
    expect(
      detectCoverageClaims(
        'The curated library could not be consulted for this turn, so I have no information on password rotation.'
      )
    ).toEqual(['couldNotConsult']);
    expect(detectCoverageClaims('I could not access the library, so there is no coverage I can point you to.')).toEqual(
      ['couldNotConsult']
    );
    expect(
      detectCoverageClaims('The library could not be consulted, so nothing about that is available to me.')
    ).toEqual(['couldNotConsult']);
  });

  it('still flags a corpus claim made in the same sentence as a speaker-scoped one', () => {
    // Sentence-level scoping must not become a blanket excuse: this reply asserts the library lacks
    // the material, which an outage never establishes, and the "I have nothing else" clause after it
    // does not undo that.
    expect(
      detectCoverageClaims('The library does not cover password rotation and I have nothing else on it.')
    ).toContain('notCovered');
  });

  it('does not let a clause boundary hide a corpus claim from the speaker-scope window', () => {
    // Both of these put the overreach and the hedge in ONE sentence, split only by punctuation that
    // is not a full stop - the shape sentence-level scoping was introduced for, and the shape that
    // fails permissively if the window or the split is too generous.
    expect(
      detectCoverageClaims('There is no coverage of password rotation, but I could not consult the library.')
    ).toContain('notCovered');
    expect(detectCoverageClaims('No documents mention password rotation; I could not search them anyway.')).toContain(
      'notCovered'
    );
  });

  it('flags a could-not-consult claim', () => {
    expect(detectCoverageClaims('The curated library could not be consulted on this turn.')).toContain(
      'couldNotConsult'
    );
    expect(detectCoverageClaims('I was unable to search your documents.')).toContain('couldNotConsult');
    // Same concession, the other conjugation - it read as "answered without naming the gap" before.
    expect(detectCoverageClaims('I was not able to consult the library, so there are no records I can cite.')).toEqual([
      'couldNotConsult',
    ]);
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

  it('passes an unavailable turn that concedes the outage and its own empty hands', () => {
    // The phrasings a real run produces put both claims in one sentence. Before sentence-level
    // speaker scoping these graded as overreach, which would have red-flagged the honest reply on
    // the finding this eval exists to protect.
    for (const reply of [
      'The curated library could not be consulted for this turn, so I have no information on password rotation. Want me to retry?',
      'I could not access the library, so there is no coverage I can point you to.',
      'The library could not be consulted, so nothing about that is available to me.',
    ]) {
      const result = gradeMustHedge(reply, 'unavailable');
      expect(result.passed, `${reply} -> ${result.reason}`).toBe(true);
    }
  });

  it('lets a full no-match search say plainly that it is not covered', () => {
    expect(gradeMustHedge('The library does not cover password rotation.', 'no_match').passed).toBe(true);
  });
});
