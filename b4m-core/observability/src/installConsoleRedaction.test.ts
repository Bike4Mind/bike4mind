import { afterEach, describe, expect, it, vi } from 'vitest';
import { installConsoleRedaction } from './installConsoleRedaction';
import { Logger } from './logger';

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
const ALL_METHODS = [...METHODS, 'dir', 'table'] as const;

function fakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    dir: vi.fn(),
    table: vi.fn(),
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

describe('installConsoleRedaction argument shapes', () => {
  it('redacts only the data argument of dir and table', () => {
    const target = fakeConsole();
    const originals = { ...target };
    installConsoleRedaction(target);
    const options = { depth: 4 };
    target.dir({ otc: '123456' }, options);
    target.table([{ email: 'jane@example.com' }], ['email']);
    expect(originals.dir).toHaveBeenCalledWith({ otc: '[REDACTED]' }, options);
    expect(originals.dir.mock.calls[0][1]).toBe(options);
    expect(originals.table).toHaveBeenCalledWith([{ email: '***@example.com' }], ['email']);
  });

  it('rebuilds a top-level Error as a real Error with a redacted message and stack', () => {
    const target = fakeConsole();
    const original = target.error;
    installConsoleRedaction(target);
    const error = Object.assign(new TypeError('send failed for jane@example.com'), { code: 'E_SEND' });
    target.error('failed', error);
    const logged = original.mock.calls[0][1] as Error & { code?: string };
    expect(logged).toBeInstanceOf(Error);
    expect(logged.name).toBe('TypeError');
    expect(logged.message).toBe('send failed for ***@example.com');
    expect(logged.stack).toContain('TypeError: send failed for ***@example.com');
    expect(logged.stack).not.toContain('jane@');
    expect(logged.code).toBe('E_SEND');
  });

  it('keeps a scrubbed stack for a provider error and drops its payload', () => {
    const target = fakeConsole();
    const original = target.error;
    installConsoleRedaction(target);
    const error = Object.assign(new Error('rate limited for jane@example.com'), {
      status: 429,
      response: { body: 'secret payload' },
    });
    target.error(error);
    const logged = original.mock.calls[0][0] as Error & { status?: number; response?: unknown };
    expect(logged).toBeInstanceOf(Error);
    expect(logged.status).toBe(429);
    expect(logged.response).toBeUndefined();
    expect(logged.stack).toContain('Error: rate limited for ***@example.com');
    expect(logged.stack).toContain('installConsoleRedaction.test');
  });
});

describe('installConsoleRedaction with the Logger', () => {
  const saved = Object.fromEntries(ALL_METHODS.map(m => [m, console[m]])) as Record<
    (typeof ALL_METHODS)[number],
    Console['log']
  >;

  afterEach(() => {
    for (const method of ALL_METHODS) console[method] = saved[method];
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
    for (const method of ALL_METHODS) console[method] = saved[method];
    const withShim = captureLoggerLine(true);
    expect(withShim).toEqual(without);
    expect(typeof withShim[0]).toBe('string');
  });
});
