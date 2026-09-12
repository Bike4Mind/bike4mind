import { describe, expect, it } from 'vitest';
import { factFigures, figureScopedSubject, fromDisjointSources, statesDifferentFigures } from './conflict';
import { subjectKey } from './subject';

describe('factFigures', () => {
  it('reads a figure regardless of how it was spelled', () => {
    // The currency symbol and the unit sit outside the match, so these are one figure written
    // three ways rather than three figures.
    expect([...factFigures('Price is $10')]).toEqual(['10']);
    expect([...factFigures('Price is 10 dollars')]).toEqual(['10']);
    expect([...factFigures('Uptime is 10%')]).toEqual(['10']);
  });

  it('canonicalizes formatting so it is not read as disagreement', () => {
    expect(factFigures('Uptime is 99.90%')).toEqual(factFigures('Uptime is 99.9%'));
    expect(factFigures('Revenue was 1,200')).toEqual(factFigures('Revenue was 1200'));
  });

  it('is empty for a fact that states no figure', () => {
    expect(factFigures('The service is generally available').size).toBe(0);
  });
});

describe('statesDifferentFigures', () => {
  it('separates the disagreement that de-dup would otherwise destroy', () => {
    // Measured at ~0.99 cosine against the live embedding model, i.e. well above the de-dup
    // threshold: without this guard the second of these replaces the first outright.
    expect(statesDifferentFigures('Uptime is 99.9%', 'Uptime is 99.5%')).toBe(true);
    expect(statesDifferentFigures('Latency is 250ms', 'Latency is 400ms')).toBe(true);
  });

  it('lets a restatement coalesce', () => {
    expect(statesDifferentFigures('Uptime is 99.9%', 'Uptime is 99.90%')).toBe(false);
    expect(statesDifferentFigures('Uptime is 99.9%', 'The uptime is 99.9 percent')).toBe(false);
  });

  it('treats a figure-free fact as a restatement rather than a disagreement', () => {
    // De-dup exists to coalesce qualitative re-mentions; only a differing FIGURE is decidable here.
    expect(statesDifferentFigures('Support is excellent', 'Support is outstanding')).toBe(false);
    expect(statesDifferentFigures('Uptime is 99.9%', 'Uptime is generally good')).toBe(false);
  });

  it('notices a figure added or dropped, not just one changed', () => {
    expect(statesDifferentFigures('Uptime is 99.9% across 3 regions', 'Uptime is 99.9%')).toBe(true);
  });

  /**
   * The classes the number pattern deliberately does not read, pinned so the limit is a decision
   * rather than a surprise. Every one of them answers "restatement", which is the pre-existing
   * de-dup behaviour - the guard can fail to rescue a disagreement, never destroy one it saw.
   */
  it('reads an unsigned figure, so a sign flip alone is not a disagreement', () => {
    expect(statesDifferentFigures('Delta is -5', 'Delta is 5')).toBe(false);
  });

  it('does not read non-ASCII digits', () => {
    // Escaped rather than literal: this file is ASCII-only per CLAUDE.md, and the escape keeps the
    // codepoints under test visible in review.
    expect(statesDifferentFigures('Uptime is \u0669\u0669%', 'Uptime is \u0665\u0665%')).toBe(false);
  });

  it('collapses integers past float precision onto one another', () => {
    expect(statesDifferentFigures('Id is 12345678901234567890', 'Id is 12345678901234567891')).toBe(false);
  });
});

describe('fromDisjointSources', () => {
  it('is true only when no document is shared', () => {
    expect(fromDisjointSources(['docA'], ['docB'])).toBe(true);
    expect(fromDisjointSources(['docA'], ['docA'])).toBe(false);
    expect(fromDisjointSources(['docA', 'docB'], ['docB', 'docC'])).toBe(false);
  });

  it('is false when either side has no provenance to compare', () => {
    // Unknown provenance must not be read as "a different document" - that would split a
    // re-extraction of one document into two competing beliefs.
    expect(fromDisjointSources([], ['docA'])).toBe(false);
    expect(fromDisjointSources(['docA'], [])).toBe(false);
  });
});

describe('figureScopedSubject', () => {
  it('keeps two disagreeing readings off the same subject', () => {
    // The reason this function exists: subjectKey drops single-character tokens, so both of these
    // reduce to the same key and the preserved claim would hash straight back onto the belief it
    // was being kept apart from.
    expect(subjectKey('Uptime is 99.9%')).toEqual(subjectKey('Uptime is 99.5%'));

    const a = figureScopedSubject(subjectKey('Uptime is 99.9%'), 'Uptime is 99.9%');
    const b = figureScopedSubject(subjectKey('Uptime is 99.5%'), 'Uptime is 99.5%');
    expect(a).not.toEqual(b);
  });

  it('is deterministic, so re-extracting one document still coalesces across runs', () => {
    const once = figureScopedSubject(subjectKey('Uptime is 99.9%'), 'Uptime is 99.9%');
    const twice = figureScopedSubject(subjectKey('Uptime is 99.9%'), 'Uptime is 99.9%');
    expect(once).toEqual(twice);
  });

  it('is order-insensitive in the figures it appends', () => {
    expect(figureScopedSubject('s', 'up 3 then 10')).toEqual(figureScopedSubject('s', 'up 10 then 3'));
  });

  it('falls back to the derived subject when there is no figure to scope by', () => {
    expect(figureScopedSubject('derived', 'no figures here')).toBe('derived');
  });
});
