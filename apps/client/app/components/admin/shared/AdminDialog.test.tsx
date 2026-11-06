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

  it('renders nothing while closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('test-dialog')).toBeNull();
  });
});
