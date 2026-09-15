import { describe, it, expect } from 'vitest';
import { buildWontFixCommentBody, WONT_FIX_COMMENT_MARKER, WONT_FIX_FIELD_MAX_CHARS } from './wontFixComment';

describe('buildWontFixCommentBody', () => {
  const baseDiagnosis = {
    rootCause: 'something went wrong',
    proposedFix: 'no change needed',
    confidence: 95,
  };

  it('starts with the dedup marker for both variants', () => {
    const initial = buildWontFixCommentBody(baseDiagnosis, 'initial');
    const revision = buildWontFixCommentBody(baseDiagnosis, 'revision');
    expect(initial.startsWith(WONT_FIX_COMMENT_MARKER)).toBe(true);
    expect(revision.startsWith(WONT_FIX_COMMENT_MARKER)).toBe(true);
  });

  it('uses different header text per variant', () => {
    const initial = buildWontFixCommentBody(baseDiagnosis, 'initial');
    const revision = buildWontFixCommentBody(baseDiagnosis, 'revision');
    expect(initial).toContain('**SRE Agent — No Fix Needed**');
    expect(initial).toContain('Diagnosis completed');
    expect(revision).toContain('**SRE Agent — No Fix Needed (Revision)**');
    expect(revision).toContain('Re-diagnosis completed');
  });

  it('includes Root cause, Reason, and Confidence lines', () => {
    const body = buildWontFixCommentBody(baseDiagnosis, 'initial');
    expect(body).toContain('*Root cause:* something went wrong');
    expect(body).toContain('*Reason:* no change needed');
    expect(body).toContain('*Confidence:* 95%');
  });

  it("renders 'N/A' when rootCause or proposedFix is missing", () => {
    const body = buildWontFixCommentBody({ confidence: 80 }, 'initial');
    expect(body).toContain('*Root cause:* N/A');
    expect(body).toContain('*Reason:* N/A');
    expect(body).toContain('*Confidence:* 80%');
  });

  it('escapes Markdown specials in LLM-sourced fields', () => {
    const body = buildWontFixCommentBody(
      {
        rootCause: 'undefined `*foo*` at [oops]',
        proposedFix: 'fix _here_',
        confidence: 95,
      },
      'initial'
    );
    expect(body).toContain('\\`\\*foo\\*\\`');
    expect(body).toContain('\\[oops\\]');
    expect(body).toContain('\\_here\\_');
  });

  it('neutralizes @-mentions in LLM-sourced fields to prevent pings', () => {
    const body = buildWontFixCommentBody(
      {
        rootCause: 'cc @StormyEmery',
        proposedFix: 'route to @MillionOnMars/platform',
        confidence: 95,
      },
      'initial'
    );
    expect(body).toContain('@​StormyEmery');
    expect(body).toContain('@​MillionOnMars/platform');
    expect(body).not.toContain('@StormyEmery');
    expect(body).not.toContain('@MillionOnMars/platform');
  });

  it('truncates rootCause and proposedFix at the configured max', () => {
    const longRoot = 'r'.repeat(800);
    const longFix = 'f'.repeat(800);
    const body = buildWontFixCommentBody(
      {
        rootCause: longRoot,
        proposedFix: longFix,
        confidence: 90,
      },
      'initial'
    );
    expect(body).toContain('r'.repeat(WONT_FIX_FIELD_MAX_CHARS));
    expect(body).not.toContain('r'.repeat(WONT_FIX_FIELD_MAX_CHARS + 1));
    expect(body).toContain('f'.repeat(WONT_FIX_FIELD_MAX_CHARS));
    expect(body).not.toContain('f'.repeat(WONT_FIX_FIELD_MAX_CHARS + 1));
  });
});
