import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ResizableSplitter from './ResizableSplitter';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderSplitter = (onWidthChange?: (w: number) => void) =>
  render(
    <Wrapper>
      <ResizableSplitter onWidthChange={onWidthChange} />
    </Wrapper>
  );

const handle = () => screen.getByTestId('session-splitter-handle');
const width = () => useSessionLayout.getState().knowledgeViewerWidth;

describe('ResizableSplitter', () => {
  beforeEach(() => {
    setSessionLayout({ knowledgeViewerWidth: 50 });
  });

  it('exposes a named window splitter carrying the current split', () => {
    renderSplitter();

    const splitter = screen.getByRole('separator', { name: 'Resize the chat and knowledge panes' });

    expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
    expect(splitter).toHaveAttribute('aria-valuenow', '50');
    expect(splitter).toHaveAttribute('aria-valuemin', '20');
    expect(splitter).toHaveAttribute('aria-valuemax', '80');
    expect(splitter).toHaveAttribute('aria-valuetext', 'Knowledge pane 50%');
    expect(splitter).toHaveAttribute('tabindex', '0');
  });

  // The viewer is the right-hand pane (the split renders row-reversed), so moving the
  // separator right has to shrink it.
  it('steps the separator right on ArrowRight and left on ArrowLeft', () => {
    renderSplitter();

    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(width()).toBe(48);

    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(width()).toBe(52);
  });

  it('jumps to the clamps on Home and End', () => {
    renderSplitter();

    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(width()).toBe(20);

    fireEvent.keyDown(handle(), { key: 'End' });
    expect(width()).toBe(80);
  });

  it('holds the arrow steps inside the same clamps the drag uses', () => {
    setSessionLayout({ knowledgeViewerWidth: 21 });
    renderSplitter();

    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(width()).toBe(20);

    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(width()).toBe(20);
  });

  // A drag commits a fractional width; the arrows must not carry that fraction forward,
  // or the value a screen reader announces stops matching the one that is stored.
  it('snaps to whole percents when stepping off a width a drag left behind', () => {
    setSessionLayout({ knowledgeViewerWidth: 47.382 });
    renderSplitter();

    fireEvent.keyDown(handle(), { key: 'ArrowRight' });

    expect(width()).toBe(45);
    expect(handle()).toHaveAttribute('aria-valuenow', '45');
  });

  it('reports keyboard resizes through onWidthChange, like a drag', () => {
    const onWidthChange = vi.fn();
    renderSplitter(onWidthChange);

    fireEvent.keyDown(handle(), { key: 'End' });

    expect(onWidthChange).toHaveBeenCalledWith(80);
  });

  it('swallows the keys it handles and leaves the rest alone', () => {
    renderSplitter();

    // fireEvent returns false when the handler called preventDefault, which is what stops
    // the arrows from scrolling the pane behind the handle.
    expect(fireEvent.keyDown(handle(), { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(handle(), { key: 'Tab' })).toBe(true);
    expect(width()).toBe(48);
  });
});

// jsdom does not lay the split row out, so the equal-gutters outcome itself is a preview
// check. What it does resolve is the handle's own width and margins (plain px longhands,
// not Joy `calc(var(--joy-spacing))` values), which is the whole input to the invariant:
// the handle's outer size has to be zero or the row no longer sums to 100%.
const measureHandle = () => {
  renderSplitter();
  const style = getComputedStyle(handle());
  const box = {
    width: parseFloat(style.width),
    marginLeft: parseFloat(style.marginLeft),
    marginRight: parseFloat(style.marginRight),
  };
  // Guard the measurement itself: if jsdom ever stops resolving the emitted rule these come
  // back NaN, and every assertion below would fail for a reason that has nothing to do with
  // the layout.
  for (const [prop, value] of Object.entries(box)) {
    if (!Number.isFinite(value)) throw new Error(`jsdom did not resolve ${prop}`);
  }
  return box;
};

describe('ResizableSplitter geometry', () => {
  it('contributes zero width to the split row', () => {
    const { width: handleWidth, marginLeft, marginRight } = measureHandle();

    expect(handleWidth + marginLeft + marginRight).toBe(0);
  });

  it('keeps the grab strip centered on the pane boundary', () => {
    const { marginLeft, marginRight } = measureHandle();

    expect(marginLeft).toBe(marginRight);
    expect(marginLeft).toBeLessThan(0);
  });

  it('keeps the grab strip wide enough to catch with a pointer', () => {
    // Zeroing both the width and the margins would satisfy the sum above while leaving
    // only the 2px ::before bar to aim at.
    expect(measureHandle().width).toBeGreaterThanOrEqual(8);
  });
});
