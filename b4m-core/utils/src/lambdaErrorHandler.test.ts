import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerLambdaErrorHandlers, _resetLambdaErrorHandlers } from './lambdaErrorHandler';

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

describe('registerLambdaErrorHandlers', () => {
  const originalListeners = {
    unhandledRejection: process.listeners('unhandledRejection'),
    uncaughtException: process.listeners('uncaughtException'),
    rejectionHandled: process.listeners('rejectionHandled'),
  };

  beforeEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('rejectionHandled');
    _resetLambdaErrorHandlers();
  });

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('rejectionHandled');
    originalListeners.unhandledRejection.forEach(l =>
      process.on('unhandledRejection', l as (reason: unknown, promise: Promise<unknown>) => void)
    );
    originalListeners.uncaughtException.forEach(l => process.on('uncaughtException', l as (error: Error) => void));
    originalListeners.rejectionHandled.forEach(l =>
      process.on('rejectionHandled', l as (promise: Promise<unknown>) => void)
    );
    _resetLambdaErrorHandlers();
  });

  it('classifies and absorbs undici TypeError("terminated") as a network rejection', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    const handled = new Promise<void>(resolve => {
      process.once('rejectionHandled', () => resolve());
    });

    Promise.reject(new TypeError('terminated'));
    await flushMicrotasks();
    await handled;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, entry] = logger.warn.mock.calls[0];
    expect(message).toBe('[Lambda] Network error (unhandled rejection)');
    expect(entry).toMatchObject({ category: 'network_terminated', error: 'terminated' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('absorbs "fetch failed" TypeErrors', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    const handled = new Promise<void>(resolve => {
      process.once('rejectionHandled', () => resolve());
    });

    Promise.reject(new TypeError('fetch failed'));
    await flushMicrotasks();
    await handled;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1].category).toBe('network_terminated');
  });

  it('absorbs connection errors like ECONNRESET', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    const handled = new Promise<void>(resolve => {
      process.once('rejectionHandled', () => resolve());
    });

    Promise.reject(new Error('socket hang up ECONNRESET'));
    await flushMicrotasks();
    await handled;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1].category).toBe('network_connection');
  });

  it('absorbs AbortError as a network timeout', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    const handled = new Promise<void>(resolve => {
      process.once('rejectionHandled', () => resolve());
    });

    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    Promise.reject(abort);
    await flushMicrotasks();
    await handled;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1].category).toBe('network_timeout');
  });

  it('logs but does NOT absorb non-network rejections', async () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    // Emit synthetically so vitest's own unhandled-rejection tracker doesn't race us.
    // The promise is pre-handled with .catch() to satisfy vitest; we only care that
    // our handler logs to .error (not .warn) and does not attach an additional catch.
    const settled = Promise.reject(new Error('application bug'));
    settled.catch(() => {});
    process.emit('unhandledRejection', new Error('application bug'), settled);
    await flushMicrotasks();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toBe('[Lambda] Unhandled promise rejection');
    expect(logger.error.mock.calls[0][1].category).toBe('unhandled_rejection');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an EPIPE uncaught exception as a network warning, not an error (#8197)', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    // Reproduces the uncaught "write EPIPE" (broken pipe on a closed socket).
    process.emit('uncaughtException', new Error('write EPIPE'));

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1].category).toBe('network_connection');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a genuine uncaught exception as an error', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    registerLambdaErrorHandlers(logger as never);

    process.emit('uncaughtException', new Error('application bug'));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toBe('[Lambda] Uncaught exception');
    expect(logger.error.mock.calls[0][1].category).toBe('uncaught_exception');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('is idempotent — repeated calls do not stack listeners', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const before = process.listenerCount('unhandledRejection');
    registerLambdaErrorHandlers(logger as never);
    registerLambdaErrorHandlers(logger as never);
    registerLambdaErrorHandlers(logger as never);
    expect(process.listenerCount('unhandledRejection') - before).toBe(1);
  });
});
