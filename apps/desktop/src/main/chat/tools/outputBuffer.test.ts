import { describe, expect, it } from 'vitest';
import { OutputBuffer } from './outputBuffer';

describe('OutputBuffer', () => {
  it('returns only what arrived since the last cursor', () => {
    const buffer = new OutputBuffer(1_000);
    buffer.push('stdout', 'first\n');

    const one = buffer.read(0, 500);
    expect(one.text).toBe('first\n');

    buffer.push('stdout', 'second\n');
    const two = buffer.read(one.cursor, 500);
    expect(two.text).toBe('second\n');
    expect(two.missed).toBe(0);
  });

  it('reports nothing new rather than repeating itself', () => {
    const buffer = new OutputBuffer(1_000);
    buffer.push('stdout', 'only\n');

    const first = buffer.read(0, 500);
    expect(buffer.read(first.cursor, 500).text).toBe('');
  });

  it('keeps the newest output when the cap is exceeded, and says how much it dropped', () => {
    const buffer = new OutputBuffer(10);
    buffer.push('stdout', 'abcdefghij');
    buffer.push('stdout', 'KLMNO');

    expect(buffer.tail(100)).toBe('fghijKLMNO');
    expect(buffer.droppedChars).toBe(5);
    expect(buffer.retainedChars).toBe(10);
  });

  /** A reader whose cursor predates a trim must be told, not handed a silent gap. */
  it('tells a stale reader how much it missed', () => {
    const buffer = new OutputBuffer(10);
    buffer.push('stdout', 'abcde');
    buffer.push('stdout', 'fghijklmno');

    // Never read, so its cursor is still 0 - and the first five characters are long gone.
    const next = buffer.read(0, 100);

    expect(next.missed).toBe(5);
    expect(next.text).toBe('fghijklmno');
  });

  /** Having already read what was later trimmed is not a gap, and must not be reported as one. */
  it('does not invent a gap for output the reader had already seen', () => {
    const buffer = new OutputBuffer(10);
    buffer.push('stdout', 'abcde');
    const cursor = buffer.read(0, 100).cursor;

    buffer.push('stdout', 'fghijklmno');
    expect(buffer.read(cursor, 100).missed).toBe(0);
  });

  it('caps a single read to the newest characters, counting the rest as missed', () => {
    const buffer = new OutputBuffer(1_000);
    buffer.push('stdout', 'x'.repeat(50));

    const slice = buffer.read(0, 10);
    expect(slice.text).toHaveLength(10);
    expect(slice.missed).toBe(40);
    // The cursor still advances past everything produced, so the next read is not a rerun.
    expect(buffer.read(slice.cursor, 10).text).toBe('');
  });

  it('labels the streams only when both appear, so a stderr-only log stays clean', () => {
    const quiet = new OutputBuffer(1_000);
    quiet.push('stderr', 'listening on 3000\n');
    expect(quiet.tail(500)).toBe('listening on 3000\n');

    const mixed = new OutputBuffer(1_000);
    mixed.push('stdout', 'ok\n');
    mixed.push('stderr', 'warn\n');
    const text = mixed.tail(500);
    expect(text).toContain('[stdout]');
    expect(text).toContain('[stderr]');
    expect(text.indexOf('ok')).toBeLessThan(text.indexOf('warn'));
  });
});
