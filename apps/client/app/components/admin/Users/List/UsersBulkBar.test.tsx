import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { USERS_BULK_ACTIONS, USERS_BULK_ACTION_COPY } from './UsersBulkActionDialog';
import { UsersBulkBar } from './UsersBulkBar';

const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;

const renderBar = () =>
  render(
    <UsersBulkBar
      selection={{ mode: 'explicit', ids: ['a'.repeat(24)] }}
      totalMatching={10}
      onSelectAllMatching={vi.fn()}
      onClear={vi.fn()}
      onAction={vi.fn()}
    />,
    { wrapper: Wrapper }
  );

describe('UsersBulkBar help', () => {
  it('explains every bulk action from a help button', async () => {
    renderBar();
    expect(screen.queryByTestId('admin-users-bulk-legend')).toBeNull();

    const help = screen.getByTestId('admin-users-bulk-help-btn');
    expect(help).toHaveAccessibleName('About bulk actions');
    fireEvent.click(help);

    const legend = await screen.findByTestId('admin-users-bulk-legend');
    for (const type of USERS_BULK_ACTIONS) {
      const entry = within(legend).getByTestId(`admin-users-bulk-legend-${type}`);
      expect(entry).toHaveTextContent(USERS_BULK_ACTION_COPY[type].label);
      expect(entry).toHaveTextContent(USERS_BULK_ACTION_COPY[type].description);
    }
    expect(legend).toHaveTextContent('undo it for 30 seconds');
  });
});
