import { describe, expect, it } from 'vitest';
import { formatLoopInterval, loopDecision, loopDuration, loopUntil, parseLoop } from './loop';

describe('/loop grammar', () => {
  it('accepts supported bounded durations and keeps nested skills intact', () => {
    expect(parseLoop('5m /review src/index.ts')).toEqual({
      kind: 'start',
      intervalMs: 300_000,
      prompt: '/review src/index.ts',
    });
    for (const [text, value] of [
      ['30s', 30_000],
      ['1h', 3_600_000],
      ['1d', 86_400_000],
    ] as const) {
      expect(loopDuration(text)).toBe(value);
    }
    expect(parseLoop('check the build')).toEqual({ kind: 'start', intervalMs: null, prompt: 'check the build' });
  });

  it.each([
    '',
    '5m',
    '0s task',
    '29s task',
    '-1m task',
    '1.5m task',
    '1ms task',
    '2d task',
    '999999999999999999h task',
    'Infinity task',
    '5minutes task',
    '1e3s task',
    '30s /loop task',
    '/loop stop',
  ])('refuses unsafe or incomplete input: %s', text => {
    expect(parseLoop(text)).toHaveProperty('error');
  });

  it('recognizes management commands only as whole arguments', () => {
    for (const kind of ['stop', 'list', 'help']) expect(parseLoop(kind)).toEqual({ kind });
    expect(parseLoop('list the jobs')).toMatchObject({ kind: 'start' });
  });

  it.each(['2fa status', '-v check', 'explain what /loop does', 'do /LOOP 5m task'])(
    'allows ordinary prompt text: %s',
    prompt => {
      expect(parseLoop(prompt)).toEqual({ kind: 'start', prompt, intervalMs: null });
    }
  );

  it('formats cadence in the largest whole unit', () => {
    expect(formatLoopInterval(86_400_000)).toBe('1d');
    expect(formatLoopInterval(3_600_000)).toBe('1h');
    expect(formatLoopInterval(300_000)).toBe('5m');
    expect(formatLoopInterval(30_000)).toBe('30s');
  });

  it('requires an exact bounded scheduling decision at the end of a reply', () => {
    expect(loopDecision('Build is still running.\nLOOP_NEXT: 2m')).toBe(120_000);
    for (const reply of [
      'LOOP_NEXT: 1s',
      'LOOP_NEXT: 2d',
      'LOOP_NEXT: 1m\nOther text',
      'Use 5m',
      '```\nLOOP_NEXT: 5m\n```',
    ]) {
      expect(loopDecision(reply)).toBeNull();
    }
  });

  describe('--until', () => {
    const now = new Date(2026, 4, 1, 12, 0).getTime();
    const today = (hour: number, minute = 0) => new Date(2026, 4, 1, hour, minute).getTime();

    it('reads options only from the front, in either order, and keeps later text as prompt', () => {
      expect(parseLoop('1h --until 18:00 /review src', now)).toEqual({
        kind: 'start',
        intervalMs: 3_600_000,
        until: today(18),
        prompt: '/review src',
      });
      expect(parseLoop('--until 6pm 5m check', now)).toEqual({
        kind: 'start',
        intervalMs: 300_000,
        until: today(18),
        prompt: 'check',
      });
      expect(parseLoop('check --until 18:00', now)).toEqual({
        kind: 'start',
        intervalMs: null,
        prompt: 'check --until 18:00',
      });
    });

    it.each([
      ['18:30', today(18, 30)],
      ['9pm', today(21)],
      ['12:15pm', today(12, 15)],
      ['2026-05-02T09:00', new Date(2026, 4, 2, 9).getTime()],
      ['2026-05-02 09:00', new Date(2026, 4, 2, 9).getTime()],
      ['2026-05-02T09:00:00Z', Date.UTC(2026, 4, 2, 9)],
    ])('resolves %s', (text, expected) => {
      expect(loopUntil(text, now)).toBe(expected);
    });

    it.each([
      ['11:00', 'already passed'],
      ['12am', 'already passed'],
      ['2026-05-09T12:01', 'within 7 days'],
      ['18', 'Invalid end time'],
      ['25:00', 'Invalid end time'],
      ['13pm', 'Invalid end time'],
      ['tomorrow', 'Invalid end time'],
      ['2026-02-30T10:00', 'Invalid end time'],
    ])('refuses %s', (text, message) => {
      expect(loopUntil(text, now)).toEqual({ error: expect.stringContaining(message) });
      expect(parseLoop(`5m --until ${text} check`, now)).toEqual({ error: expect.stringContaining(message) });
    });

    it('needs a value and a prompt', () => {
      expect(parseLoop('5m --until', now)).toHaveProperty('error');
      expect(parseLoop('5m --until 18:00', now)).toHaveProperty('error');
      expect(parseLoop('--until 18:00 /loop stop', now)).toEqual({ error: 'A loop cannot invoke another /loop.' });
    });
  });
});
