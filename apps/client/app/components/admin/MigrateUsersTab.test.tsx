import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

vi.mock('@client/app/utils/organizationAPICalls', () => ({
  useGetAllOrganizations: () => ({ data: undefined, isLoading: true }),
}));
const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@client/app/utils/userAPICalls', () => ({
  useMigrateUsers: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({
  default: ({ tooltipText }: { tooltipText: string }) => <button type="button">{tooltipText}</button>,
}));
vi.mock('../common/SingleOrganizationSelector', () => ({ default: () => null }));

import MigrateUsersTab from './MigrateUsersTab';
import { buildMigratedUsersCsv } from '@client/app/utils/migratedUsersCsv';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MigrateUsersTab />
    </CssVarsProvider>
  );

const created = [
  { name: 'Ada Example', email: 'ada@example.com' },
  { name: 'Bo Example', email: 'bo@example.com' },
];

const typeList = (value: string) => {
  fireEvent.change(screen.getByPlaceholderText(/Enter user list/), { target: { value } });
};

const parseAndMigrate = ({ sendEmail }: { sendEmail: boolean }) => {
  renderTab();
  if (sendEmail) fireEvent.click(screen.getByLabelText('Send Welcome Email to Users'));
  typeList('Ada Example, ada@example.com\nBo Example, bo@example.com');
  fireEvent.click(screen.getByRole('button', { name: 'Parse User List' }));
  fireEvent.click(screen.getByRole('button', { name: 'Migrate Users' }));
};

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

  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.mutate.mockImplementation((_vars, { onSuccess }) => onSuccess({ createdUsers: created }));
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
  });

  it('keeps Parse disabled until a list is entered', () => {
    renderTab();
    expect(screen.getByRole('button', { name: 'Parse User List' })).toBeDisabled();
  });

  it('parses two valid lines into a two-row table', () => {
    renderTab();
    typeList('Ada Example, ada@example.com\nBo Example, bo@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Parse User List' }));

    const table = screen.getByTestId('migrate-parsed-users-table');
    expect(within(table).getByText('Ada Example')).toBeInTheDocument();
    expect(within(table).getByText('bo@example.com')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(3);
  });

  it('shows the format message and no table when a line is malformed', () => {
    renderTab();
    typeList('Ada Example, ada@example.com\nnot an email line');
    fireEvent.click(screen.getByRole('button', { name: 'Parse User List' }));

    expect(screen.getByText('The data entered does not match the given format.')).toBeInTheDocument();
    expect(screen.queryByTestId('migrate-parsed-users-table')).not.toBeInTheDocument();
  });

  it('lists the created users with the no-email warning when no email was sent', () => {
    parseAndMigrate({ sendEmail: false });

    expect(mocks.mutate).toHaveBeenCalledWith(
      { usersData: created, sendEmail: false, orgId: '' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
    const dialog = screen.getByTestId('migrate-created-users-dialog');
    expect(within(dialog).getAllByRole('row')).toHaveLength(3);
    expect(within(dialog).getByTestId('migrate-no-email-warning')).toHaveTextContent('No welcome email was sent');
  });

  it('lists every created user in the dialog, without paging', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: `User ${i}`, email: `user${i}@example.com` }));
    mocks.mutate.mockImplementation((_vars, { onSuccess }) => onSuccess({ createdUsers: many }));
    parseAndMigrate({ sendEmail: false });

    const dialog = screen.getByTestId('migrate-created-users-dialog');
    expect(within(dialog).getAllByRole('row')).toHaveLength(31);
    expect(within(dialog).getByText('user29@example.com')).toBeInTheDocument();
  });

  it('leaves out the warning when the welcome email was sent', () => {
    parseAndMigrate({ sendEmail: true });

    expect(screen.getByTestId('migrate-created-users-dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('migrate-no-email-warning')).not.toBeInTheDocument();
  });

  it('copies the created users as CSV', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    parseAndMigrate({ sendEmail: false });

    fireEvent.click(screen.getByTestId('migrate-copy-csv-btn'));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(buildMigratedUsersCsv(created));
  });

  it('reports a failed copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    parseAndMigrate({ sendEmail: false });

    fireEvent.click(screen.getByTestId('migrate-copy-csv-btn'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to copy CSV.'));
  });

  it('closes the created-users dialog', async () => {
    parseAndMigrate({ sendEmail: false });

    fireEvent.click(screen.getByTestId('migrate-created-users-done-btn'));
    await waitFor(() => expect(screen.queryByTestId('migrate-created-users-dialog')).not.toBeInTheDocument());
  });
});
