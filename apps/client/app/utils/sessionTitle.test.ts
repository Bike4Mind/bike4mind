import { describe, it, expect } from 'vitest';
import { formatSessionTitle } from './sessionTitle';

describe('formatSessionTitle', () => {
  it('passes through a normal plain-text title', () => {
    expect(formatSessionTitle('Classic sunset art request')).toBe('Classic sunset art request');
  });

  it('extracts a headline from a JSON-object name', () => {
    const raw = '{ "editorialMode": "grin", "headline": "The Epistemology of Cats" }';
    expect(formatSessionTitle(raw)).toBe('The Epistemology of Cats');
  });

  it('prefers headline, then title, then name, then subject', () => {
    expect(formatSessionTitle('{"title":"T","name":"N"}')).toBe('T');
    expect(formatSessionTitle('{"name":"N","subject":"S"}')).toBe('N');
    expect(formatSessionTitle('{"subject":"S"}')).toBe('S');
  });

  it('falls back to the first string value when no labeled field exists', () => {
    const raw = '{"lens":"claims","confidence":0.85,"reasoning":"Technical STEM"}';
    expect(formatSessionTitle(raw)).toBe('claims');
  });

  it('clamps long titles and appends an ellipsis', () => {
    const long = 'a'.repeat(200);
    const out = formatSessionTitle(long);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not announce a multi-KB JSON body — extracts the headline instead', () => {
    const raw = JSON.stringify({ headline: 'Parked car as grid battery', body: 'x'.repeat(2000) });
    const out = formatSessionTitle(raw);
    expect(out).toBe('Parked car as grid battery');
    expect(out.length).toBeLessThan(80);
  });

  it('strips wrapping quotes/asterisks and collapses newlines', () => {
    expect(formatSessionTitle('  "Hello"  ')).toBe('Hello');
    expect(formatSessionTitle('**Bold title**')).toBe('Bold title');
    expect(formatSessionTitle('line one\nline two')).toBe('line one line two');
  });

  it('returns a fallback for empty / nullish / unusable input', () => {
    expect(formatSessionTitle('')).toBe('Untitled session');
    expect(formatSessionTitle(null)).toBe('Untitled session');
    expect(formatSessionTitle(undefined)).toBe('Untitled session');
    expect(formatSessionTitle('{}')).toBe('Untitled session');
  });

  it('treats malformed JSON-looking strings as plain text', () => {
    expect(formatSessionTitle('{not valid json')).toBe('{not valid json');
  });

  it('strips wrapping underscores and backticks', () => {
    expect(formatSessionTitle('_Hello_')).toBe('Hello');
    expect(formatSessionTitle('`code title`')).toBe('code title');
  });

  it('does not split a surrogate pair when clamping (no lone surrogate)', () => {
    const out = formatSessionTitle('😀'.repeat(100));
    expect(out.endsWith('…')).toBe(true);
    // no high surrogate left without its trailing low surrogate
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});
