import { describe, expect, it } from 'vitest';
import {
  FORCED_RETRIEVAL_NO_CONTEXT_RULES,
  forcedRetrievalNoContextPrompt,
  type ForcedRetrievalNoContextFinding,
} from './forcedRetrievalAbstention';

const FINDINGS: ForcedRetrievalNoContextFinding[] = ['unavailable', 'no_match_partial', 'no_match'];

describe('forcedRetrievalNoContextPrompt', () => {
  it.each(FINDINGS)('carries the conditional rules on %s', finding => {
    // Every instruction is conditional on the request depending on the library. Without this the
    // block becomes an unconditional refusal and a "thanks" draws an apology about coverage.
    expect(forcedRetrievalNoContextPrompt(finding)).toContain(FORCED_RETRIEVAL_NO_CONTEXT_RULES);
    expect(forcedRetrievalNoContextPrompt(finding)).toMatch(/if the request depends on that library/i);
  });

  it.each(FINDINGS)('labels itself so the model knows nothing was retrieved (%s)', finding => {
    expect(forcedRetrievalNoContextPrompt(finding)).toContain('[Knowledge Base - No Retrieved Context]');
  });

  it.each(FINDINGS)('forbids filling the gap from parametric knowledge on %s', finding => {
    const prompt = forcedRetrievalNoContextPrompt(finding);
    expect(prompt).toMatch(/do not fill the gap from general knowledge/i);
    expect(prompt).toMatch(/never invent sources, citations, or figures/i);
  });

  // The three findings are distinct precisely because only one of them supports "the library does
  // not cover this". Collapsing them would let an outage reach a user as a missing document, which is
  // the regression most worth locking.
  it('never lets an unavailable library read as absent coverage', () => {
    const prompt = forcedRetrievalNoContextPrompt('unavailable');
    expect(prompt).toMatch(/could not be searched/i);
    expect(prompt).toMatch(/do not say or imply the library lacks coverage/i);
  });

  it('keeps a cut-short search from hardening into "nothing exists"', () => {
    const prompt = forcedRetrievalNoContextPrompt('no_match_partial');
    expect(prompt).toMatch(/only part of the curated library could be searched/i);
    expect(prompt).toMatch(/do not state or imply the library has no coverage/i);
    expect(prompt).toMatch(/the search was incomplete/i);
  });

  it('is the only finding that may state the library does not cover the topic', () => {
    const prompt = forcedRetrievalNoContextPrompt('no_match');
    expect(prompt).toMatch(/say plainly that it does not cover this/i);
    expect(prompt).not.toMatch(/do not (?:say|state) or imply/i);
  });

  it('gives each finding its own body, so a refactor cannot silently alias two of them', () => {
    const bodies = FINDINGS.map(forcedRetrievalNoContextPrompt);
    expect(new Set(bodies).size).toBe(FINDINGS.length);
  });
});
