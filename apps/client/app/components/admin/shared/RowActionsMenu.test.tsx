import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { MenuItem } from '@mui/joy';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { RowActionsMenu } from './RowActionsMenu';

const theme = extendTheme({ ...getThemeConfig() });

const renderMenu = (props: Partial<React.ComponentProps<typeof RowActionsMenu>> = {}, onRowClick = vi.fn()) => {
  const onEdit = vi.fn();
  render(
    <CssVarsProvider theme={theme}>
      <div data-testid="row" onClick={onRowClick}>
        <RowActionsMenu testId="row-actions" ariaLabel="Actions for Ada" {...props}>
          <MenuItem onClick={onEdit} data-testid="row-edit">
            Edit
          </MenuItem>
        </RowActionsMenu>
      </div>
    </CssVarsProvider>
  );
  return { onEdit, onRowClick };
};

describe('RowActionsMenu', () => {
  it('names the trigger and opens its items from one button', async () => {
    const { onEdit } = renderMenu();
    const trigger = screen.getByTestId('row-actions');
    expect(trigger).toHaveAttribute('aria-label', 'Actions for Ada');
    expect(screen.queryByTestId('row-edit')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByTestId('row-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('row-edit')).not.toBeInTheDocument();
  });

  it('does not open while disabled', () => {
    renderMenu({ disabled: true });
    expect(screen.getByTestId('row-actions')).toBeDisabled();
    fireEvent.click(screen.getByTestId('row-actions'));
    expect(screen.queryByTestId('row-edit')).not.toBeInTheDocument();
  });

  it('lets the click reach the row by default', async () => {
    const { onRowClick } = renderMenu();
    fireEvent.click(screen.getByTestId('row-actions'));
    await screen.findByTestId('row-edit');
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('keeps trigger and item clicks from reaching the row with stopRowClick', async () => {
    const { onEdit, onRowClick } = renderMenu({ stopRowClick: true });
    fireEvent.click(screen.getByTestId('row-actions'));
    fireEvent.click(await screen.findByTestId('row-edit'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
