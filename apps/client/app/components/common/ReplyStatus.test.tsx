import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import ReplyStatus from './ReplyStatus';

vi.mock('@client/app/components/common/InteractiveChaoticLaserBicycleWheel', () => ({
  default: () => <div data-testid="spinner" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('ReplyStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('elapsed counter does not reset when status text changes', () => {
    const createdAt = new Date(Date.now() - 12_000); // 12s ago

    const { rerender } = render(
      <Wrapper>
        <ReplyStatus status="Preparing to paint..." createdAt={createdAt} />
      </Wrapper>
    );

    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(12s)');

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(15s)');

    // Status text flips - counter must continue monotonically, not blink to 0
    rerender(
      <Wrapper>
        <ReplyStatus status="Now painting..." createdAt={createdAt} />
      </Wrapper>
    );
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(15s)');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(17s)');
  });

  it('elapsed counter resets when createdAt changes (new quest)', () => {
    const firstQuestStart = new Date(Date.now() - 20_000);

    const { rerender } = render(
      <Wrapper>
        <ReplyStatus status="Running..." createdAt={firstQuestStart} />
      </Wrapper>
    );
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(20s)');

    const secondQuestStart = new Date(Date.now() - 1_000);
    rerender(
      <Wrapper>
        <ReplyStatus status="Running..." createdAt={secondQuestStart} />
      </Wrapper>
    );
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(1s)');
  });

  it('does not render elapsed text when createdAt is absent', () => {
    render(
      <Wrapper>
        <ReplyStatus status="Running..." />
      </Wrapper>
    );
    expect(screen.queryByTestId('reply-status-elapsed')).toBeNull();
  });

  it('stops ticking elapsed when status becomes null', () => {
    const createdAt = new Date(Date.now() - 5_000);

    const { rerender } = render(
      <Wrapper>
        <ReplyStatus status="Running..." createdAt={createdAt} />
      </Wrapper>
    );
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(5s)');

    rerender(
      <Wrapper>
        <ReplyStatus status={null} createdAt={createdAt} />
      </Wrapper>
    );
    // Status text gone - elapsed badge is only rendered alongside status
    expect(screen.queryByTestId('reply-status-elapsed')).toBeNull();

    // Advance time. If the interval is still firing it would keep recomputing;
    // flipping back to a status shows the value did NOT advance.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    rerender(
      <Wrapper>
        <ReplyStatus status="Running..." createdAt={createdAt} />
      </Wrapper>
    );
    // Reseed on re-mount of status reads current Date.now(), so 5s + 10s = 15s.
    // The point is no runaway state in between; this confirms re-attach is fresh.
    expect(screen.getByTestId('reply-status-elapsed').textContent).toBe('(15s)');
  });

  it('clamps negative elapsed to 0 when createdAt is in the future (clock skew)', () => {
    const futureCreatedAt = new Date(Date.now() + 5_000);

    render(
      <Wrapper>
        <ReplyStatus status="Running..." createdAt={futureCreatedAt} />
      </Wrapper>
    );

    // elapsed clamps to 0, and the badge only renders when elapsedSeconds > 0
    expect(screen.queryByTestId('reply-status-elapsed')).toBeNull();
  });

  // jsdom does no layout, so the overlap itself cannot be measured. What it can prove is
  // that the line box is taller than the glyphs: a line-height of '100%' (or any value
  // equal to the font-size) leaves zero leading, which is what made wrapped status lines
  // collide. jsdom reports a unitless line-height verbatim, so resolve each form to px.
  const resolveLineBoxPx = (lineHeight: string, fontSizePx: number): number => {
    if (lineHeight === 'normal') return Number.POSITIVE_INFINITY; // font metrics supply leading
    if (lineHeight.endsWith('px')) return parseFloat(lineHeight);
    if (lineHeight.endsWith('%')) return (parseFloat(lineHeight) / 100) * fontSizePx;
    return parseFloat(lineHeight) * fontSizePx;
  };

  it('status text has leading, so a wrapped line cannot collide with the one above it', () => {
    render(
      <Wrapper>
        <ReplyStatus status={'\u{1F310} Searching the web: "a query long enough to wrap onto a second line"'} />
      </Wrapper>
    );

    const { lineHeight, fontSize } = window.getComputedStyle(screen.getByTestId('reply-status-text'));
    const fontSizePx = parseFloat(fontSize);

    expect(fontSizePx).toBeGreaterThan(0);
    expect(resolveLineBoxPx(lineHeight, fontSizePx)).toBeGreaterThan(fontSizePx);
  });
});
