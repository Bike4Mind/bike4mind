import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/utils/organizationAPICalls', () => ({
  useGetAllOrganizations: () => ({ data: undefined, isLoading: true }),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({
  useMigrateUsers: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ tooltipText }: { tooltipText: string }) => <button type="button">{tooltipText}</button>,
}));
vi.mock('../common/SingleOrganizationSelector', () => ({ default: () => null }));

import MigrateUsersTab from './MigrateUsersTab';

const appTheme = extendTheme({ ...getThemeConfig() });

describe('MigrateUsersTab', () => {
  it('opens with the shared page header, holding the only h1 and the help button, before any orgs load', () => {
    const { container } = render(
      <CssVarsProvider theme={appTheme}>
        <MigrateUsersTab />
      </CssVarsProvider>
    );

    const header = screen.getByTestId('admin-page-header');
    expect(container.firstElementChild?.firstElementChild).toBe(header);
    expect(screen.getAllByRole('heading', { level: 1 }).map(h => h.textContent)).toEqual(['Migrate users']);
    expect(
      within(screen.getByTestId('admin-page-header-actions')).getByRole('button', { name: 'User migration help' })
    ).toBeInTheDocument();
  });
});
