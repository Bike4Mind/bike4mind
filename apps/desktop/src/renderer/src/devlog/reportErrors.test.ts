// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installErrorReporting } from './reportErrors';

describe('installErrorReporting', () => {
  it('maps error and unhandledrejection events', () => {
    const target = new EventTarget();
    const report = vi.fn();
    installErrorReporting(target as unknown as Window, report);

    const error = new TypeError('bad thing');
    target.dispatchEvent(
      Object.assign(new Event('error'), {
        message: 'Uncaught TypeError: bad thing',
        error,
        filename: 'a.js',
        lineno: 3,
        colno: 7,
      })
    );
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('nope') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain' }));

    expect(report).toHaveBeenNthCalledWith(1, {
      kind: 'error',
      message: 'bad thing',
      name: 'TypeError',
      location: 'a.js:3:7',
    });
    expect(report).toHaveBeenNthCalledWith(2, { kind: 'unhandledrejection', message: 'nope', name: 'RangeError' });
    expect(report).toHaveBeenNthCalledWith(3, { kind: 'unhandledrejection', message: 'plain' });
  });

  it('swallows a throwing reporter', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    };
    installErrorReporting(target as unknown as Window, () => {
      throw new Error('ipc down');
    });
    expect(() => listeners.get('error')?.(Object.assign(new Event('error'), { message: 'x' }))).not.toThrow();
  });

  it('is a no-op without a reporter', () => {
    expect(() => installErrorReporting(new EventTarget() as unknown as Window, undefined)).not.toThrow();
  });

  it('does not throw when the reason cannot be stringified', () => {
    const listeners = new Map<string, (event: Event) => void>();
    const target = {
      addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
    };
    const report = vi.fn();
    installErrorReporting(target as unknown as Window, report);
    const reason = Object.create(null);
    expect(() =>
      listeners.get('unhandledrejection')?.(Object.assign(new Event('unhandledrejection'), { reason }))
    ).not.toThrow();
    expect(report).not.toHaveBeenCalled();
  });
});
