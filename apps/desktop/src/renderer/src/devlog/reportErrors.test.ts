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

  it('swallows a throwing reporter and is a no-op without one', () => {
    const target = new EventTarget();
    installErrorReporting(target as unknown as Window, () => {
      throw new Error('ipc down');
    });
    expect(() => target.dispatchEvent(Object.assign(new Event('error'), { message: 'x' }))).not.toThrow();
    expect(() => installErrorReporting(new EventTarget() as unknown as Window, undefined)).not.toThrow();
  });
});
