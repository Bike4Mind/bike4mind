import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction } from './installConsoleRedaction';
import { Logger } from './logger';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

function fakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('installConsoleRedaction', () => {
  it('scrubs strings and redacts sensitive keys on every wrapped method', () => {
    const target = fakeConsole();
    const originals = { ...target };
    installConsoleRedaction(target);

    for (const method of METHODS) {
      target[method]('send failed for', 'jane@example.com', { otc: '123456' });
      expect(originals[method]).toHaveBeenCalledWith('send failed for', '***@example.com', { otc: '[REDACTED]' });
    }
  });

  it('is idempotent: a second install does not wrap again', () => {
    const target = fakeConsole();
    installConsoleRedaction(target);
    const wrapped = target.error;
    installConsoleRedaction(target);
    expect(target.error).toBe(wrapped);
  });

  it('passes non-object values through unchanged', () => {
    const target = fakeConsole();
    const original = target.log;
    installConsoleRedaction(target);
    target.log(42, null, undefined, true);
    expect(original).toHaveBeenCalledWith(42, null, undefined, true);
  });

  it('does not recurse when redacting a value triggers another console call', () => {
    const target = fakeConsole();
    const original = target.warn;
    installConsoleRedaction(target);
    const noisy = {
      toJSON() {
        target.warn('nested for jane@example.com', 7, { otc: '123456' });
        return { ok: true };
      },
    };
    target.warn(noisy);
    expect(original).toHaveBeenNthCalledWith(1, 'nested for ***@example.com', 7, '[Unserializable]');
    expect(original).toHaveBeenNthCalledWith(2, { ok: true });
  });
});

describe('installConsoleRedaction with the Logger', () => {
  const saved = Object.fromEntries(METHODS.map(m => [m, console[m]])) as Record<
    (typeof METHODS)[number],
    Console['log']
  >;

  afterEach(() => {
    for (const method of METHODS) console[method] = saved[method];
    delete (console as unknown as Record<symbol, unknown>)[Symbol.for('@bike4mind/observability/consoleRedaction')];
  });

  function captureLoggerLine(withShim: boolean) {
    const sink = vi.fn();
    console.error = sink;
    if (withShim) installConsoleRedaction();
    new Logger({ metadata: { service: 'example' }, logInJson: true, prettyPrint: false }).error('job finished', {
      count: 3,
      at: '2026-01-01T00:00:00.000Z',
    });
    expect(sink).toHaveBeenCalledTimes(1);
    return sink.mock.calls[0];
  }

  it('leaves a Logger line with nothing to redact byte-identical', () => {
    const without = captureLoggerLine(false);
    for (const method of METHODS) console[method] = saved[method];
    const withShim = captureLoggerLine(true);
    expect(withShim).toEqual(without);
    expect(typeof withShim[0]).toBe('string');
  });
});
