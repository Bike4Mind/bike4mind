import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePreventStrayFileDrop } from './usePreventStrayFileDrop';

/**
 * jsdom has no real DataTransfer, so fabricate a cancelable drag event whose
 * `dataTransfer.types` we control, dispatch it on `document`, and inspect whether
 * the hook's listener called preventDefault (observable via `defaultPrevented`).
 */
function dispatchDrag(type: 'dragover' | 'drop', types: string[]): Event {
  const event = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types }, configurable: true });
  document.dispatchEvent(event);
  return event;
}

describe('usePreventStrayFileDrop', () => {
  // renderHook auto-unmounts between tests, so each test's cleanup effect removes the
  // document listeners before the next one runs - no manual teardown needed.
  it('prevents the browser default for a file dragover while mounted', () => {
    renderHook(() => usePreventStrayFileDrop());
    expect(dispatchDrag('dragover', ['Files']).defaultPrevented).toBe(true);
  });

  it('prevents the browser default for a file drop while mounted', () => {
    renderHook(() => usePreventStrayFileDrop());
    expect(dispatchDrag('drop', ['Files']).defaultPrevented).toBe(true);
  });

  it('leaves non-file drags (e.g. in-app element drags) alone', () => {
    renderHook(() => usePreventStrayFileDrop());
    expect(dispatchDrag('drop', ['text/plain']).defaultPrevented).toBe(false);
  });

  it('removes its listeners on unmount so drops are no longer prevented', () => {
    const { unmount } = renderHook(() => usePreventStrayFileDrop());
    unmount();
    expect(dispatchDrag('drop', ['Files']).defaultPrevented).toBe(false);
  });
});
