import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { QuoteActions } from './QuoteActions';

/**
 * The quote toolbar is a desktop mouse feature. It must mount on fine (mouse)
 * pointers and stay entirely absent on coarse (touch) pointers, where its
 * mouse-emulation listeners fought native touch selection (see #458).
 */

vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: (selector: (s: { setChatInputValue: () => void }) => unknown) =>
    selector({ setChatInputValue: vi.fn() }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

function mockPointer(fine: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('pointer: fine') ? fine : !fine,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Make window.getSelection report a non-empty selection so a mouseup would
// surface the toolbar - if (and only if) the listener is attached.
function stubSelection(text = 'partial selection') {
  const range = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 40, height: 16 }) };
  window.getSelection = vi.fn().mockReturnValue({
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  }) as unknown as typeof window.getSelection;
}

describe('QuoteActions pointer gating', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    stubSelection();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows the quote toolbar after a mouse selection on fine (mouse) pointers', () => {
    mockPointer(true);
    render(
      <Wrapper>
        <QuoteActions containerRef={{ current: container }} />
      </Wrapper>
    );

    act(() => {
      fireEvent.mouseUp(container);
      vi.advanceTimersByTime(100); // handleTextSelection re-reads the selection on a 100ms delay
    });

    expect(screen.getByText('Explain')).toBeTruthy();
  });

  it('never mounts the toolbar on coarse (touch) pointers', () => {
    mockPointer(false);
    render(
      <Wrapper>
        <QuoteActions containerRef={{ current: container }} />
      </Wrapper>
    );

    act(() => {
      fireEvent.mouseUp(container);
      vi.advanceTimersByTime(100);
    });

    expect(screen.queryByText('Explain')).toBeNull();
  });
});
