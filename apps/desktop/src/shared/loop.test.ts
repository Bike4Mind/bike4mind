import { describe, expect, it } from 'vitest';
import { loopDecision, loopDuration, parseLoop } from './loop';

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
    'do /LOOP 5m task',
  ])('refuses unsafe or incomplete input: %s', text => {
    expect(parseLoop(text)).toHaveProperty('error');
  });

  it('recognizes management commands only as whole arguments', () => {
    for (const kind of ['stop', 'list', 'help']) expect(parseLoop(kind)).toEqual({ kind });
    expect(parseLoop('list the jobs')).toMatchObject({ kind: 'start' });
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
});
