import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from './logger';

function jsonLogger(metadata: Record<string, unknown> = {}) {
  return new Logger({ metadata, logInJson: true, prettyPrint: false, minLevel: 'debug' });
}

function captureJson(level: 'debug' | 'info' | 'warn' | 'error', emit: (logger: Logger) => void) {
  const spy = vi.spyOn(console, level).mockImplementation(() => {});
  emit(jsonLogger({ context: 'example' }));
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Logger.parseArgs metadata placement', () => {
  it('treats a trailing object as structured metadata', () => {
    expect(captureJson('warn', l => l.warn('call failed', { error: 'boom' }))).toEqual({
      context: 'example',
      error: 'boom',
      severity: 'warn',
      message: 'call failed',
    });
  });

  it('treats a leading object as structured metadata (pino-style)', () => {
    expect(captureJson('warn', l => l.warn({ error: 'boom' }, 'call failed'))).toEqual({
      context: 'example',
      error: 'boom',
      severity: 'warn',
      message: 'call failed',
    });
  });

  it('joins every remaining string into the message for a metadata-first call', () => {
    expect(captureJson('info', l => l.info({ id: 7 }, 'saved', 'record'))).toEqual({
      context: 'example',
      id: 7,
      severity: 'info',
      message: 'saved record',
    });
  });

  it('prefers the trailing object when a call supplies objects at both ends', () => {
    const entry = captureJson('debug', l => l.debug({ first: 1 }, 'both', { last: 2 }));
    expect(entry.last).toBe(2);
    expect(entry.first).toBeUndefined();
    expect(entry.message).toBe('{"first":1} both');
  });

  it('keeps a leading object in the message when a later argument is an object', () => {
    const entry = captureJson('info', l => l.info({ first: 1 }, ['a', 'b']));
    expect(entry.first).toBeUndefined();
    expect(entry.message).toBe('{"first":1} ["a","b"]');
  });

  it('lifts a leading object past non-string primitives in the message', () => {
    const entry = captureJson('info', l => l.info({ attempt: 2 }, 'retrying after', 500));
    expect(entry.attempt).toBe(2);
    expect(entry.message).toBe('retrying after 500');
  });

  it('keeps a leading class instance in the message rather than erasing it', () => {
    const entry = captureJson('info', l => l.info(new Date('2020-01-02T03:04:05.000Z'), 'boot complete'));
    expect(entry.message).toBe('"2020-01-02T03:04:05.000Z" boot complete');
  });

  it('keeps a lone object in the message', () => {
    const entry = captureJson('info', l => l.info({ only: 1 }));
    expect(entry.only).toBeUndefined();
    expect(entry.message).toBe('{"only":1}');
  });

  it('keeps a leading Error out of metadata', () => {
    const entry = captureJson('error', l => l.error(new Error('kaboom'), 'while saving'));
    expect(entry.message).toContain('kaboom');
    expect(entry.message).toContain('while saving');
  });

  it('keeps a trailing Error out of metadata', () => {
    const entry = captureJson('error', l => l.error('while saving', new Error('kaboom')));
    expect(entry.message).toContain('kaboom');
  });

  it('lifts metadata-first fields on error()', () => {
    const entry = captureJson('error', l => l.error({ userId: 'u1' }, 'while saving'));
    expect(entry.userId).toBe('u1');
    expect(entry.message).toBe('while saving');
  });

  it('serializes an Error nested in metadata with its name, message and stack', () => {
    const entry = captureJson('error', l => l.error({ err: new Error('kaboom') }, 'pipeline failed'));
    const err = entry.err as { name: string; message: string; stack: string };
    expect(err.name).toBe('Error');
    expect(err.message).toBe('kaboom');
    expect(err.stack).toContain('kaboom');
    expect(entry.message).toBe('pipeline failed');
  });

  it('lets call metadata override instance metadata regardless of position', () => {
    expect(captureJson('warn', l => l.warn({ context: 'override' }, 'msg')).context).toBe('override');
  });
});
