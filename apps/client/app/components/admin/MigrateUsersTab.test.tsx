import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';

const { migrate } = vi.hoisted(() => ({ migrate: vi.fn() }));

vi.mock('@client/app/utils/organizationAPICalls', () => ({
  useGetAllOrganizations: () => ({ data: [] }),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({
  useMigrateUsers: () => ({ mutate: migrate, isPending: false }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ tooltipText }: { tooltipText: string }) => <button type="button" aria-label={tooltipText} />,
}));
vi.mock('../common/SingleOrganizationSelector', () => ({
  default: () => <div data-testid="mock-org-selector" />,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import MigrateUsersTab from './MigrateUsersTab';

const theme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={theme}>
      <MigrateUsersTab />
    </CssVarsProvider>
  );

describe('MigrateUsersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens with the shared page header, named like its sidebar item, as the only h1', () => {
    const { container } = renderTab();

    const header = screen.getByTestId('admin-page-header');
    const title = screen.getByRole('heading', { level: 1 });
    expect(container.firstElementChild?.firstElementChild).toBe(header);
    expect(screen.getAllByRole('heading')[0]).toBe(title);
    expect(header).toContainElement(title);
    expect(title).toHaveAccessibleName('Migration');
    expect(SIDEBAR_SECTIONS.flatMap(s => s.items).find(i => i.tab === AdminTab.Migrate)?.label).toBe('Migration');
  });

  it('puts the help and tutorial buttons in the header actions', () => {
    renderTab();

    const actions = screen.getByTestId('admin-page-header-actions');
    expect(within(actions).getByRole('button', { name: 'User Migration Help' })).toBeInTheDocument();
    expect(within(actions).getByRole('button', { name: 'Migration Tutorial' })).toBeInTheDocument();
  });

  it('still parses the list and migrates the parsed users from the page body', () => {
    renderTab();

    const migrateButton = screen.getByRole('button', { name: 'Migrate Users' });
    expect(migrateButton).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Enter user list (name, email) separated by commas and new lines'), {
      target: { value: 'Ada Lovelace, ada@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parse User List' }));
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();

    fireEvent.click(migrateButton);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0][0]).toMatchObject({
      usersData: [{ name: 'Ada Lovelace', email: 'ada@example.com' }],
    });
  });
});
