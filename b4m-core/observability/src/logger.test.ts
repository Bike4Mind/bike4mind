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

function prettyLogger(metadata: Record<string, unknown> = {}) {
  return new Logger({ metadata, logInJson: false, prettyPrint: true, minLevel: 'debug' });
}

/** Returns the single console call's arguments, joined into one string for substring assertions. */
function capturePretty(level: 'debug' | 'info' | 'warn' | 'error', emit: (logger: Logger) => void) {
  const spy = vi.spyOn(console, level).mockImplementation(() => {});
  emit(prettyLogger({ context: 'example' }));
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0].join(' ');
}

function plainLogger(metadata: Record<string, unknown> = {}) {
  return new Logger({ metadata, logInJson: false, prettyPrint: false, minLevel: 'debug' });
}

function capturePlain(level: 'debug' | 'info' | 'warn' | 'error', emit: (logger: Logger) => void) {
  const spy = vi.spyOn(console, level).mockImplementation(() => {});
  emit(plainLogger({ context: 'example' }));
  expect(spy).toHaveBeenCalledTimes(1);
  return spy.mock.calls[0] as unknown[];
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

  it('logs the cause of an undici-style fetch failure, including its code', () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' });
    const entry = captureJson('error', l =>
      l.error({ err: new TypeError('fetch failed', { cause }) }, 'Quest processing failed')
    );
    const err = entry.err as { message: string; cause: { code: string; message: string; syscall: string } };
    expect(err.message).toBe('fetch failed');
    expect(err.cause).toMatchObject({ code: 'ECONNRESET', message: 'read ECONNRESET', syscall: 'read' });
  });

  it('logs the cause of an Error passed as a leading argument', () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' });
    const entry = captureJson('error', l => l.error(new TypeError('fetch failed', { cause }), 'while saving'));
    expect(entry.message).toContain('ENOTFOUND');
  });

  it('serializes a cause chain in the replacer, capping depth and cutting cycles', () => {
    const replace = (value: unknown) => JSON.parse(JSON.stringify(value, Logger['errorReplacer']));

    const chain = Array.from({ length: 10 }, (_, i) => new Error(`level-${i}`));
    chain.forEach((error, i) => {
      if (i < chain.length - 1) error.cause = chain[i + 1];
    });
    let depth = 0;
    for (let node = replace(chain[0]); typeof node === 'object'; node = node.cause) depth++;
    expect(depth).toBeLessThan(chain.length);

    const a = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(replace(a).cause.cause).toBe('[Truncated]');
  });

  it('keeps a non-Error cause as is', () => {
    const entry = captureJson('error', l => l.error({ err: new Error('boom', { cause: 'plain reason' }) }, 'failed'));
    expect((entry.err as { cause: unknown }).cause).toBe('plain reason');
  });

  it('lets call metadata override instance metadata regardless of position', () => {
    expect(captureJson('warn', l => l.warn({ context: 'override' }, 'msg')).context).toBe('override');
  });

  it('preserves own enumerable properties of a nested Error alongside name/message/stack', () => {
    class HttpError extends Error {
      constructor(
        message: string,
        public statusCode: number,
        public additionalInfo: Record<string, unknown>
      ) {
        super(message);
        this.name = 'HttpError';
      }
    }
    const entry = captureJson('error', l =>
      l.error({ err: new HttpError('bad request', 400, { field: 'x' }) }, 'req failed')
    );
    const err = entry.err as { name: string; message: string; statusCode: number; additionalInfo: unknown };
    expect(err.name).toBe('HttpError');
    expect(err.message).toBe('bad request');
    expect(err.statusCode).toBe(400);
    expect(err.additionalInfo).toEqual({ field: 'x' });
  });

  it('does not throw when the leading arg is a hostile proxy', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap throws');
        },
      }
    );
    expect(() => captureJson('info', l => l.info(hostile, 'still logs'))).not.toThrow();
  });
});

describe('Logger metadata-first rendering on non-JSON branches', () => {
  it('renders a clean message plus the error metadata line in pretty output', () => {
    const line = capturePretty('info', l => l.info({ err: new Error('kaboom') }, 'pipeline failed'));
    expect(line).toContain('pipeline failed');
    expect(line).not.toContain('{"err":{}}');
    expect(line).toContain('err:');
    expect(line).toContain('kaboom');
  });

  it('renders a clean message plus the metadata object in plain output', () => {
    const [message, metadata] = capturePlain('warn', l => l.warn({ error: 'boom' }, 'call failed'));
    expect(message).toBe('call failed');
    expect(metadata).toMatchObject({ context: 'example', error: 'boom' });
  });
});

describe('Logger.globalInstance lazy construction', () => {
  const LOGGER_ENV_KEYS = ['IS_LOCAL', 'NODE_ENV', 'SST_LIVE', 'LOG_JSON', 'LOG_PRETTY', 'LOG_LEVEL'];
  const originalEnv = process.env;
  let readKeys: string[];

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  async function importFreshWithRecordedEnv() {
    vi.resetModules();
    readKeys = [];
    process.env = new Proxy(
      { ...originalEnv },
      {
        get(target, key) {
          if (typeof key === 'string') readKeys.push(key);
          return Reflect.get(target, key);
        },
      }
    );
    return (await import('./logger')).Logger;
  }

  it('reads no env at import, then only Logger keys on first access', async () => {
    const FreshLogger = await importFreshWithRecordedEnv();
    expect(readKeys).toEqual([]);

    const first = FreshLogger.globalInstance;
    expect(readKeys.length).toBeGreaterThan(0);
    expect(readKeys.every(key => LOGGER_ENV_KEYS.includes(key))).toBe(true);

    const keysAfterFirst = [...readKeys];
    expect(FreshLogger.globalInstance).toBe(first);
    expect(readKeys).toEqual(keysAfterFirst);
  });

  it('routes the static helpers through the memoized instance', async () => {
    const FreshLogger = await importFreshWithRecordedEnv();
    const spy = vi.spyOn(FreshLogger.globalInstance, 'info').mockImplementation(() => {});
    FreshLogger.info('x');
    expect(spy).toHaveBeenCalledWith('x');
  });
});

describe('log redaction', () => {
  it.each([
    { logInJson: true, prettyPrint: false },
    { logInJson: false, prettyPrint: true },
    { logInJson: false, prettyPrint: false },
  ])('redacts provider payloads in every output format: %j', options => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger({ ...options, metadata: { body: { password: 'password-canary' } } });
    const error = Object.assign(new Error('context length exceeded'), {
      isAxiosError: true,
      config: { headers: { Authorization: 'Bearer key-canary', 'xi-api-key': 'xi-canary' }, data: 'request-canary' },
      response: { data: 'response-canary' },
    });
    logger
      .withMetadata({ message: 'user-message-canary', messages: [{ content: 'conversation-canary' }] })
      .error('Provider failed', { error });
    const output = JSON.stringify(spy.mock.calls);
    for (const secret of [
      'password-canary',
      'key-canary',
      'xi-canary',
      'request-canary',
      'response-canary',
      'conversation-canary',
      'user-message-canary',
    ]) {
      expect(output).not.toContain(secret);
    }
    // The provider's own reason survives: without it an incident log cannot tell a context-length
    // failure from a throttled one.
    expect(output).toContain('context length exceeded');
    expect(output).toContain('Provider failed');
  });
});

it('keeps the provider error reason and status but withholds the response payload', () => {
  const error = Object.assign(new Error('context length exceeded'), {
    status: 400,
    headers: { 'x-request-id': 'request-1' },
    error: { message: 'nested-payload-canary' },
  });
  const entry = captureJson('error', logger => logger.error('Provider request failed', { error }));
  expect(JSON.stringify(entry)).not.toContain('nested-payload-canary');
  expect(entry.error).toMatchObject({
    name: 'Error',
    message: 'context length exceeded',
    status: 400,
    requestId: 'request-1',
  });
});

it('reads a status out of an AWS SDK metadata block', () => {
  const error = Object.assign(new Error('Rate exceeded'), { $metadata: { httpStatusCode: 429, requestId: 'aws-1' } });
  const entry = captureJson('error', logger => logger.error('AWS call failed', { error }));
  expect(entry.error).toMatchObject({ message: 'Rate exceeded', status: 429, requestId: 'aws-1' });
});

it('redacts preview aliases and tool results', () => {
  const entry = captureJson('error', logger =>
    logger.error('Request failed', {
      resultPreview: 'result-canary',
      rawResponsePreview: 'response-canary',
      resultSnippet: 'snippet-canary',
      result: 'tool-canary',
    })
  );
  const output = JSON.stringify(entry);
  for (const value of ['result-canary', 'response-canary', 'snippet-canary', 'tool-canary'])
    expect(output).not.toContain(value);
});

describe('Logger context provider', () => {
  afterEach(() => {
    Logger.setContextProvider(undefined);
    Logger.resetMetadata();
  });

  function lastJson(spy: ReturnType<typeof vi.spyOn>) {
    return JSON.parse(spy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
  }

  it("routes static calls to the provider's logger", () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const scoped = jsonLogger({ requestId: 'r1' });
    Logger.setContextProvider(() => scoped);
    Logger.info('hi');
    expect(lastJson(spy).requestId).toBe('r1');
  });

  it('falls back to the singleton when the provider yields undefined', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    Logger.globalInstance.setLevel('debug');
    Logger.setContextProvider(() => undefined);
    Logger.updateMetadata({ a: 1 });
    Logger.info('x');
    expect(spy).toHaveBeenCalled();
    expect(lastJson(spy).a).toBe(1);
  });

  it('keeps Logger.updateMetadata inside a context off the singleton', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const scoped = jsonLogger();
    Logger.setContextProvider(() => scoped);
    Logger.updateMetadata({ userId: 'u1' });
    Logger.info('scoped');
    expect(lastJson(spy).userId).toBe('u1');

    Logger.setContextProvider(undefined);
    Logger.info('later');
    expect(lastJson(spy).userId).toBeUndefined();
  });
});
