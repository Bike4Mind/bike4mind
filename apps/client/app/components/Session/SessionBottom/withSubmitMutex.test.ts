import { describe, it, expect, vi } from 'vitest';
import { withSubmitMutex } from './withSubmitMutex';

describe('withSubmitMutex', () => {
  it('leaves the mutex held on a successful send', async () => {
    const ref = { current: true };
    const setSubmitting = vi.fn();

    await expect(withSubmitMutex(ref, setSubmitting, async () => 'sent')).resolves.toBe('sent');

    // Still true: the stream is in flight, so the Stop affordance must keep rendering.
    expect(ref.current).toBe(true);
    expect(setSubmitting).not.toHaveBeenCalled();
  });

  it('releases the mutex and rethrows when the send throws', async () => {
    const ref = { current: true };
    const setSubmitting = vi.fn();
    const boom = new Error('Maximum update depth exceeded');

    await expect(
      withSubmitMutex(ref, setSubmitting, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(ref.current).toBe(false);
    expect(setSubmitting).toHaveBeenCalledWith(false);
  });

  it('still releases the ref when the state write itself throws', async () => {
    const ref = { current: true };
    const boom = new Error('original failure');
    const setSubmitting = vi.fn(() => {
      throw new Error('React is broken too');
    });

    // The original error propagates, not the state-write error.
    await expect(
      withSubmitMutex(ref, setSubmitting, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(ref.current).toBe(false);
  });

  it('releases the ref before attempting the state write', async () => {
    const ref = { current: true };
    let refAtStateWrite: boolean | undefined;
    const setSubmitting = vi.fn(() => {
      refAtStateWrite = ref.current;
    });

    await expect(
      withSubmitMutex(ref, setSubmitting, async () => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');

    expect(refAtStateWrite).toBe(false);
  });
});
