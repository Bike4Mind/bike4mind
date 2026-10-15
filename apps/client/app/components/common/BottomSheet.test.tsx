import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
