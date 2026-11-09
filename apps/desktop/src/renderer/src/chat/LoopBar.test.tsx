// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LoopState } from '@shared/loop';
import { LoopBar } from './LoopBar';

describe('LoopBar', () => {
  let root: Root;
  let host: HTMLDivElement;
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('shows cadence and next run, stops accessibly, and never touches the composer draft', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.matchMedia = vi
      .fn()
      .mockImplementation(() => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn() }));
    const state: LoopState = {
      sessionId: 's',
      prompt: '/review',
      intervalMs: 300_000,
      phase: 'scheduled',
      nextRunAt: Date.now() + 300_000,
    };
    let changed!: (event: { sessionId: string; state: LoopState | null }) => void;
    const stop = vi.fn();
    Object.defineProperty(window, 'b4m', {
      configurable: true,
      value: {
        chat: {
          getLoop: async () => state,
          onLoopChanged: (listener: typeof changed) => {
            changed = listener;
            return vi.fn();
          },
          loopCommand: stop,
        },
      },
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(
        <CssVarsProvider>
          <LoopBar sessionId="s" />
        </CssVarsProvider>
      )
    );
    const status = host.querySelector('[data-testid="loop-status"]');
    expect(status?.textContent).toContain('/review');
    expect(status?.textContent).toContain('300s after completion');
    expect(status?.textContent).toContain('Next:');
    const button = host.querySelector<HTMLButtonElement>('[data-testid="loop-stop-btn"]');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.disabled).toBe(false);
    act(() => button?.click());
    expect(stop).toHaveBeenCalledWith('s', 'stop');
    act(() => changed({ sessionId: 's', state: { ...state, phase: 'paused', nextRunAt: null, error: 'No credits' } }));
    expect(host.textContent).toContain('No credits');
    act(() => changed({ sessionId: 's', state: null }));
    expect(host.querySelector('[data-testid="loop-status"]')).toBeNull();
  });
});
