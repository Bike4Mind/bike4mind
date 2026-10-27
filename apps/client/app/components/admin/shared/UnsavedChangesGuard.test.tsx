import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';

const mocks = vi.hoisted(() => ({ blocker: vi.fn(), reset: vi.fn(), proceed: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useBlocker: mocks.blocker }));
const theme = extendTheme({ ...getThemeConfig() });
describe('UnsavedChangesGuard', () => {
  it('keeps edits or proceeds only after explicit discard and enables unload protection', () => {
    mocks.blocker.mockReturnValue({ status: 'blocked', reset: mocks.reset, proceed: mocks.proceed });
    render(
      <CssVarsProvider theme={theme}>
        <UnsavedChangesGuard dirty isLeaving={() => true} />
      </CssVarsProvider>
    );
    expect(mocks.blocker.mock.calls.at(-1)?.[0].enableBeforeUnload).toBe(true);
    fireEvent.click(screen.getByTestId('admin-unsaved-cancel-btn'));
    expect(mocks.reset).toHaveBeenCalledOnce();
    expect(mocks.proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('admin-unsaved-discard-btn'));
    expect(mocks.proceed).toHaveBeenCalledOnce();
  });
});
