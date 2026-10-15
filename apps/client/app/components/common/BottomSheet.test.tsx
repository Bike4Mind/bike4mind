import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import BottomSheet from './BottomSheet';

const appTheme = extendTheme({ ...getThemeConfig() });

beforeAll(() => {
  // jsdom has no pointer capture.
  HTMLElement.prototype.setPointerCapture = () => {};
});

const renderSheet = (onClose = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <BottomSheet open onClose={onClose} label="Add files and more" data-testid="sheet">
        <button>Row</button>
      </BottomSheet>
    </CssVarsProvider>
  );
  return onClose;
};

// A drag on the handle from y=100 down by `dy` pixels, lasting `ms`.
const swipe = (dy: number, ms: number) => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0);
  const handle = screen.getByTestId('bottom-sheet-handle');
  fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientY: 100 + dy, pointerId: 1 });
  now.mockReturnValue(ms);
  fireEvent.pointerUp(handle, { clientY: 100 + dy, pointerId: 1 });
  now.mockRestore();
};

describe('BottomSheet', () => {
  it('names its dialog and shows its content', () => {
    renderSheet();
    expect(screen.getByTestId('sheet')).toHaveAttribute('aria-label', 'Add files and more');
    expect(screen.getByRole('button', { name: 'Row' })).toBeInTheDocument();
  });

  it('renders nothing while closed, and unmounts once it has slid away', () => {
    vi.useFakeTimers();
    try {
      const sheet = (open: boolean) => (
        <CssVarsProvider theme={appTheme}>
          <BottomSheet open={open} onClose={vi.fn()} label="Actions" data-testid="sheet">
            <button>Row</button>
          </BottomSheet>
        </CssVarsProvider>
      );
      const { rerender } = render(sheet(false));
      expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();

      rerender(sheet(true));
      expect(screen.getByTestId('sheet')).toBeInTheDocument();
      // The two frames it waits before sliding in.
      act(() => vi.advanceTimersByTime(50));

      rerender(sheet(false));
      expect(screen.getByTestId('sheet')).toBeInTheDocument();
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByTestId('sheet')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on a long swipe down the handle', () => {
    const onClose = renderSheet();
    swipe(120, 600);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on a short quick flick', () => {
    const onClose = renderSheet();
    swipe(40, 40);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open after a short slow drag', () => {
    const onClose = renderSheet();
    swipe(40, 600);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores dragging upwards', () => {
    const onClose = renderSheet();
    swipe(-200, 100);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('holds the height it had while a sub-view replaces its content, then sizes freely again', () => {
    let height = 300;
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    const ui = (keepHeight: boolean, rows: number) => (
      <CssVarsProvider theme={appTheme}>
        <BottomSheet open onClose={vi.fn()} label="Menu" keepHeight={keepHeight}>
          {Array.from({ length: rows }, (_, i) => (
            <div key={i}>row {i}</div>
          ))}
        </BottomSheet>
      </CssVarsProvider>
    );
    const { rerender } = render(ui(false, 10));
    const body = screen.getByTestId('bottom-sheet-body');
    expect(body.style.height).toBe('');

    height = 100;
    rerender(ui(true, 2));
    expect(body.style.height).toBe('300px');

    rerender(ui(false, 10));
    expect(body.style.height).toBe('');
    spy.mockRestore();
  });

  it('fades the edge past which there is more to scroll', () => {
    renderSheet();
    const body = screen.getByTestId('bottom-sheet-body');
    const area = screen.getByTestId('bottom-sheet-scroll-area');
    Object.defineProperty(body, 'scrollHeight', { configurable: true, value: 700 });
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 500 });

    fireEvent.scroll(body, { target: { scrollTop: 0 } });
    expect(area).not.toHaveAttribute('data-more-above');
    expect(area).toHaveAttribute('data-more-below');

    fireEvent.scroll(body, { target: { scrollTop: 100 } });
    expect(area).toHaveAttribute('data-more-above');
    expect(area).toHaveAttribute('data-more-below');

    fireEvent.scroll(body, { target: { scrollTop: 200 } });
    expect(area).toHaveAttribute('data-more-above');
    expect(area).not.toHaveAttribute('data-more-below');
  });
});
