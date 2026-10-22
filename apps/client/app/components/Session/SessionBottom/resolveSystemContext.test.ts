import { describe, it, expect } from 'vitest';
import { PROMPT_TEXT_MAX } from '@bike4mind/common';
import { resolveSystemContext } from './resolveSystemContext';

describe('resolveSystemContext', () => {
  it.each([undefined, '', '   ', '\n\t '])('treats %j as absent', raw => {
    expect(resolveSystemContext(raw)).toEqual({ kind: 'absent' });
  });

  it('trims the value it keeps', () => {
    expect(resolveSystemContext('  Extra instructions.  ')).toEqual({
      kind: 'ok',
      systemContext: 'Extra instructions.',
    });
  });

  it('accepts a value exactly at the cap', () => {
    expect(resolveSystemContext('x'.repeat(PROMPT_TEXT_MAX)).kind).toBe('ok');
  });

  it('measures the cap after trimming, so surrounding whitespace does not push it over', () => {
    expect(resolveSystemContext(' '.repeat(5) + 'x'.repeat(PROMPT_TEXT_MAX) + ' '.repeat(5)).kind).toBe('ok');
  });

  it('refuses a value over the cap and reports its trimmed length', () => {
    expect(resolveSystemContext(' ' + 'x'.repeat(PROMPT_TEXT_MAX + 1))).toEqual({
      kind: 'tooLong',
      length: PROMPT_TEXT_MAX + 1,
    });
  });
});
