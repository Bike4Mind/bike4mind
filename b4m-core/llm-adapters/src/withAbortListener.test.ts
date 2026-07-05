import { describe, it, expect } from 'vitest';
import { getEventListeners } from 'node:events';
import { withAbortListener } from './withAbortListener';

describe('withAbortListener', () => {
  it('removes the abort listener after fn resolves', async () => {
    const controller = new AbortController();
    const listener = () => {};

    await withAbortListener(controller.signal, listener, async () => 'ok');

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes the abort listener even when fn throws (the leak case)', async () => {
    const controller = new AbortController();
    const listener = () => {};

    await expect(
      withAbortListener(controller.signal, listener, async () => {
        throw new Error('request failed');
      })
    ).rejects.toThrow('request failed');

    // Without the finally cleanup, this listener would leak - accumulating one
    // per failed call on a reused signal until MaxListenersExceededWarning fires.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not accumulate listeners across many failed calls on one signal', async () => {
    const controller = new AbortController();

    for (let i = 0; i < 20; i++) {
      await withAbortListener(
        controller.signal,
        () => {},
        async () => {
          throw new Error('boom');
        }
      ).catch(() => {});
    }

    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('invokes the listener when the signal aborts during fn', async () => {
    const controller = new AbortController();
    let fired = false;

    const promise = withAbortListener(
      controller.signal,
      () => {
        fired = true;
      },
      () => new Promise<void>(resolve => setTimeout(resolve, 10))
    );
    controller.abort();
    await promise;

    expect(fired).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('runs fn and returns its value when no signal is provided', async () => {
    const result = await withAbortListener(
      undefined,
      () => {},
      async () => 42
    );
    expect(result).toBe(42);
  });

  it('returns the resolved value of fn', async () => {
    const controller = new AbortController();
    const result = await withAbortListener(
      controller.signal,
      () => {},
      async () => 'value'
    );
    expect(result).toBe('value');
  });
});
