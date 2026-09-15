import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useFileBrowserInstance } from './instanceContext';
import { useFileBrowser } from '../Browser';

// The load-bearing seam of the refactor: with no provider mounted (the global singleton
// path), useFileBrowserInstance() must fall back to the module-level useFileBrowser store
// so the global browser behaves exactly as before the context existed.
function Probe() {
  const { selectedIds, setSelectedIds, config } = useFileBrowserInstance();
  return (
    <div>
      <span data-testid="count">{selectedIds.size}</span>
      <span data-testid="config-keys">{Object.keys(config).length}</span>
      <button data-testid="select-via-hook" onClick={() => setSelectedIds(new Set(['viaHook']))}>
        select
      </button>
    </div>
  );
}

describe('useFileBrowserInstance - no-provider fallback to the global store', () => {
  beforeEach(() => {
    act(() => {
      useFileBrowser.getState().setSelectedIds(new Set());
    });
  });

  it('reflects the global useFileBrowser store and exposes an empty config', () => {
    render(<Probe />);
    expect(screen.getByTestId('count').textContent).toBe('0');
    // Fallback supplies EMPTY_CONFIG (no onAdd/onDelete/addedFileIds/addButtonLabelKey).
    expect(screen.getByTestId('config-keys').textContent).toBe('0');

    act(() => {
      useFileBrowser.getState().setSelectedIds(new Set(['a', 'b']));
    });
    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('writes through to the global store via the returned setter', () => {
    render(<Probe />);
    act(() => {
      screen.getByTestId('select-via-hook').click();
    });
    expect(useFileBrowser.getState().selectedIds.has('viaHook')).toBe(true);
  });
});
