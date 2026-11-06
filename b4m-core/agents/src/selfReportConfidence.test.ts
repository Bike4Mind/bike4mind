import { describe, it, expect } from 'vitest';
import { parseSelfReport, SelfReportStreamFilter } from './selfReportConfidence';

describe('parseSelfReport', () => {
  it('extracts score and reason and strips the tag from the text', () => {
    const { report, text } = parseSelfReport('<confidence score="0.8">found the file</confidence>\nReading it now.');
    expect(report).toEqual({ confidence: 0.8, reason: 'found the file' });
    expect(text.trim()).toBe('Reading it now.');
  });

  it('accepts single-quoted, unquoted and uppercase variants and the 0 and 1 bounds', () => {
    expect(parseSelfReport("<confidence score='0'>x</confidence>").report?.confidence).toBe(0);
    expect(parseSelfReport('<confidence score=1>x</confidence>').report?.confidence).toBe(1);
    expect(parseSelfReport('<CONFIDENCE SCORE="0.5">x</CONFIDENCE>').report?.confidence).toBe(0.5);
  });

  it('collapses a multi-line reason to one capped line', () => {
    const long = 'word '.repeat(100);
    const { report } = parseSelfReport(`<confidence score="0.4">line one\n  line two ${long}</confidence>`);
    expect(report?.reason?.startsWith('line one line two')).toBe(true);
    expect(report?.reason?.length).toBeLessThanOrEqual(200);
    expect(report?.reason).not.toContain('\n');
  });

  it('omits reason when the tag body is empty', () => {
    expect(parseSelfReport('<confidence score="0.6"></confidence>').report).toEqual({ confidence: 0.6 });
  });

  it.each([
    ['missing score value', '<confidence score="">x</confidence>'],
    ['non-numeric score', '<confidence score="high">x</confidence>'],
    ['score above 1', '<confidence score="1.5">x</confidence>'],
    ['negative score', '<confidence score="-0.2">x</confidence>'],
    ['NaN score', '<confidence score="NaN">x</confidence>'],
    ['no tag at all', 'just a thought'],
    ['unterminated tag', '<confidence score="0.9">never closed'],
  ])('yields no report for %s', (_label, input) => {
    expect(parseSelfReport(input).report).toBeUndefined();
  });

  it('still strips a malformed tag so it never leaks into the text', () => {
    expect(parseSelfReport('a <confidence score="high">x</confidence> b').text).toBe('a  b');
  });

  it('uses the first valid report and strips every tag', () => {
    const { report, text } = parseSelfReport(
      '<confidence score="bad">x</confidence><confidence score="0.7">a</confidence><confidence score="0.2">b</confidence>done'
    );
    expect(report).toEqual({ confidence: 0.7, reason: 'a' });
    expect(text).toBe('done');
  });
});

describe('SelfReportStreamFilter', () => {
  const run = (deltas: string[]) => {
    const filter = new SelfReportStreamFilter();
    const out = deltas.map(d => filter.push(d));
    return { out, all: out.join('') + filter.flush() };
  };

  it('withholds a tag split across deltas and passes the text after it', () => {
    const { out, all } = run(['<conf', 'idence score="0.8">because', ' reasons</confidence>\n', 'Checking ', 'now']);
    expect(out.slice(0, 3)).toEqual(['', '', '']);
    expect(all).toBe('Checking now');
  });

  it('passes ordinary text straight through, including leading whitespace', () => {
    const { out } = run(['  Hello', ' world']);
    expect(out).toEqual(['  Hello', ' world']);
  });

  it('releases held text as soon as it cannot be a tag', () => {
    const { out } = run(['<', 'conf', 'etti is nice']);
    expect(out).toEqual(['', '', '<confetti is nice']);
  });

  it('is case-insensitive and handles text in the same delta as the closing tag', () => {
    expect(run(['<CONFIDENCE score="1">x</CONFIDENCE>Go']).all).toBe('Go');
  });

  it('emits a tag that never closes at flush', () => {
    const { all } = run(['<confidence score="0.5">never closed']);
    expect(all).toBe('<confidence score="0.5">never closed');
  });

  it('gives up on an oversized unclosed tag', () => {
    const { out } = run(['<confidence score="0.5">' + 'x'.repeat(700)]);
    expect(out[0]).toContain('<confidence');
  });

  it('only filters at the start: a later tag is left alone', () => {
    const { all } = run(['Hello ', '<confidence score="0.5">x</confidence>']);
    expect(all).toBe('Hello <confidence score="0.5">x</confidence>');
  });
});
