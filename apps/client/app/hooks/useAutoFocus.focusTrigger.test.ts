import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useAutoFocus } from './useAutoFocus';

describe('useAutoFocus - focusTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refocuses when focusTrigger changes without the ref/enabled changing (e.g. a prefill with no session switch)', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const ref = createRef<HTMLInputElement>();
    (ref as { current: HTMLInputElement }).current = el;
    const focusSpy = vi.spyOn(el, 'focus');

    const { rerender } = renderHook(({ trigger }) => useAutoFocus(ref, { enabled: true, focusTrigger: trigger }), {
      initialProps: { trigger: 0 },
    });
    vi.runAllTimers();
    expect(focusSpy).toHaveBeenCalledTimes(2); // immediate + the 100ms fallback

    focusSpy.mockClear();
    rerender({ trigger: 1 });
    vi.runAllTimers();
    expect(focusSpy).toHaveBeenCalledTimes(2);

    el.remove();
  });

  it('does not refocus on an unrelated re-render when focusTrigger is unchanged', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const ref = createRef<HTMLInputElement>();
    (ref as { current: HTMLInputElement }).current = el;
    const focusSpy = vi.spyOn(el, 'focus');

    const { rerender } = renderHook(({ trigger }) => useAutoFocus(ref, { enabled: true, focusTrigger: trigger }), {
      initialProps: { trigger: 0 },
    });
    vi.runAllTimers();
    focusSpy.mockClear();

    rerender({ trigger: 0 });
    vi.runAllTimers();
    expect(focusSpy).not.toHaveBeenCalled();

    el.remove();
  });

  it('does not focus on a focusTrigger bump while disabled', () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const ref = createRef<HTMLInputElement>();
    (ref as { current: HTMLInputElement }).current = el;
    const focusSpy = vi.spyOn(el, 'focus');

    const { rerender } = renderHook(({ trigger }) => useAutoFocus(ref, { enabled: false, focusTrigger: trigger }), {
      initialProps: { trigger: 0 },
    });
    vi.runAllTimers();
    expect(focusSpy).not.toHaveBeenCalled();

    rerender({ trigger: 1 });
    vi.runAllTimers();
    expect(focusSpy).not.toHaveBeenCalled();

    el.remove();
  });
});
