import { describe, it, expect } from 'vitest';
import { sanitizeSessionTitle } from './autoName';

describe('sanitizeSessionTitle (#8960)', () => {
  it('passes through a normal plain-text title', () => {
    expect(sanitizeSessionTitle('Classic sunset art request')).toBe('Classic sunset art request');
  });

  it('extracts a headline/title/name/subject from a JSON-object title', () => {
    expect(sanitizeSessionTitle('{ "editorialMode": "grin", "headline": "The Epistemology of Cats" }')).toBe(
      'The Epistemology of Cats'
    );
    expect(sanitizeSessionTitle('{"title":"T","name":"N"}')).toBe('T');
    expect(sanitizeSessionTitle('{"subject":"S"}')).toBe('S');
  });

  it('falls back to the first string value when no labeled field exists', () => {
    expect(sanitizeSessionTitle('{"lens":"claims","confidence":0.85,"reasoning":"Technical STEM"}')).toBe('claims');
  });

  it('clamps long titles to 80 chars with an ellipsis', () => {
    const out = sanitizeSessionTitle('a'.repeat(200));
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never persists a multi-KB JSON body verbatim', () => {
    const raw = JSON.stringify({ headline: 'Parked car as grid battery', body: 'x'.repeat(2000) });
    expect(sanitizeSessionTitle(raw)).toBe('Parked car as grid battery');
  });

  it('strips wrapping quotes/asterisks and collapses newlines', () => {
    expect(sanitizeSessionTitle('  "Hello"  ')).toBe('Hello');
    expect(sanitizeSessionTitle('**Bold title**')).toBe('Bold title');
    expect(sanitizeSessionTitle('line one\nline two')).toBe('line one line two');
  });

  it('returns a fallback for empty or unusable input', () => {
    expect(sanitizeSessionTitle('')).toBe('Untitled session');
    expect(sanitizeSessionTitle('{}')).toBe('Untitled session');
  });

  it('treats malformed JSON-looking strings as plain text', () => {
    expect(sanitizeSessionTitle('{not valid json')).toBe('{not valid json');
  });

  it('strips wrapping underscores and backticks', () => {
    expect(sanitizeSessionTitle('_Hello_')).toBe('Hello');
    expect(sanitizeSessionTitle('`code title`')).toBe('code title');
  });

  it('does not split a surrogate pair when clamping (no lone surrogate)', () => {
    const out = sanitizeSessionTitle('😀'.repeat(100));
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});
