import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminDialog } from './AdminDialog';

const theme = extendTheme({ ...getThemeConfig() });

const renderDialog = (props: Partial<React.ComponentProps<typeof AdminDialog>> = {}) => {
  const onClose = vi.fn();
  render(
    <CssVarsProvider theme={theme}>
      <AdminDialog title="Rename view" onClose={onClose} data-testid="test-dialog" {...props}>
        <p>Body</p>
      </AdminDialog>
    </CssVarsProvider>
  );
  return onClose;
};

describe('AdminDialog', () => {
  it('labels the dialog with its title and renders the body', () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Rename view' })).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('can announce itself as an alert dialog', () => {
    renderDialog({ role: 'alertdialog', title: 'Delete view' });
    expect(screen.getByRole('alertdialog', { name: 'Delete view' })).toBeTruthy();
  });

  it('closes from the close button', () => {
    const onClose = renderDialog();
    fireEvent.click(screen.getByTestId('test-dialog-close-btn'));
    expect(onClose).toHaveBeenCalled();
  });

  it('passes the close reason through so a caller can ignore the backdrop', () => {
    const onClose = renderDialog();
    fireEvent.click(screen.getByTestId('test-dialog-close-btn'));
    fireEvent.keyDown(screen.getByTestId('test-dialog'), { key: 'Escape' });
    const backdrop = document.querySelector('.MuiModal-backdrop');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    expect(onClose.mock.calls).toEqual([['closeClick'], ['escapeKeyDown'], ['backdropClick']]);
  });

  it('pins the dialog to the top on touch devices only when anchorTop is set', () => {
    const coarseRuleFor = (el: HTMLElement) => {
      const css = Array.from(document.styleSheets)
        .flatMap(sheet => Array.from(sheet.cssRules))
        .map(rule => rule.cssText)
        .join('\n');
      return Array.from(el.classList).some(cls =>
        new RegExp(`@media \\(pointer: coarse\\)\\s*\\{\\s*\\.${cls}\\s*\\{[^}]*top: 5%[^}]*max-height: 90vh`).test(css)
      );
    };
    const { unmount } = render(
      <CssVarsProvider theme={theme}>
        <AdminDialog title="Plain" onClose={vi.fn()} data-testid="plain-dialog">
          <p>Body</p>
        </AdminDialog>
      </CssVarsProvider>
    );
    expect(coarseRuleFor(screen.getByTestId('plain-dialog'))).toBe(false);
    unmount();
    renderDialog({ anchorTop: true });
    expect(coarseRuleFor(screen.getByTestId('test-dialog'))).toBe(true);
  });

  it('disables only the close button when closeDisabled is set', () => {
    const onClose = renderDialog({ closeDisabled: true });
    expect(screen.getByTestId('test-dialog-close-btn')).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByTestId('test-dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('escapeKeyDown');
  });

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('test-dialog')).toBeNull();
  });
});
