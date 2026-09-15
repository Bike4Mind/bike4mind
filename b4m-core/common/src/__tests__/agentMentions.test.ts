import { describe, it, expect } from 'vitest';
import { detectAgentMentions } from '../utils/agentMentions';

describe('detectAgentMentions', () => {
  it('extracts simple alphanumeric mentions', () => {
    expect(detectAgentMentions('@bob hello there')).toEqual(['bob']);
  });

  it('extracts hyphenated mentions — the case the old `\\w+` regex broke on', () => {
    expect(detectAgentMentions('@research-lead summarize')).toEqual(['research-lead']);
  });

  it('extracts multi-hyphen mentions', () => {
    expect(detectAgentMentions('@brand-voice-writer go')).toEqual(['brand-voice-writer']);
  });

  it('stops at a trailing punctuation hyphen — "@bob-" should match "@bob"', () => {
    expect(detectAgentMentions('@bob- hi')).toEqual(['bob']);
  });

  it('returns lowercase regardless of input case', () => {
    expect(detectAgentMentions('@ResearchLead')).toEqual(['researchlead']);
  });

  it('extracts multiple mentions in document order', () => {
    expect(detectAgentMentions('@alice and @research-lead, please review')).toEqual(['alice', 'research-lead']);
  });

  it('returns empty array when no mention present', () => {
    expect(detectAgentMentions('hello world')).toEqual([]);
  });

  it('ignores leading-hyphen pseudo-mentions like "@-foo"', () => {
    expect(detectAgentMentions('@-foo')).toEqual([]);
  });

  it('ignores email-like @ adjacent to a word character — "me@support.com" must not phantom-match @support', () => {
    // Regression: short handles like @support or @admin would collide with
    // email local-part suffixes and silently auto-attach agents the user
    // never mentioned. The left-boundary `(?:^|[^a-zA-Z0-9_-])` guards this.
    expect(detectAgentMentions('contact me@support.com for help')).toEqual([]);
  });
});
