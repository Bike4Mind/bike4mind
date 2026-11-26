import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { getLocalDate } from '@client/app/utils/dateUtils';

const mocks = vi.hoisted(() => ({
  modals: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  removeAsync: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deployment: vi.fn(),
  toggleState: {} as Record<string, unknown>,
  highlights: vi.fn(),
}));

const idleMutation = (mutate = vi.fn()) => ({ mutate, mutateAsync: vi.fn(), isPending: false });

vi.mock('@client/app/hooks/data/whatsNewModals', () => ({
  useGetWhatsNewModals: mocks.modals,
  useDeleteWhatsNewModal: () => ({ ...idleMutation(mocks.remove), mutateAsync: mocks.removeAsync }),
  useToggleWhatsNewModal: () => ({ ...idleMutation(mocks.toggle), ...mocks.toggleState }),
  useCreateWhatsNewModal: () => idleMutation(mocks.create),
  useUpdateWhatsNewModal: () => idleMutation(mocks.update),
  useUpdateWhatsNewModalVariants: () => idleMutation(),
  useGetRawModalVariants: () => ({ data: undefined, isLoading: false }),
  useGetHighlightsConfig: mocks.highlights,
  useUpdateHighlightsConfig: () => idleMutation(),
  useGenerateHighlights: () => idleMutation(),
}));
vi.mock('@client/app/hooks/data/admin', () => ({ useDeploymentInfo: mocks.deployment }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import AdminWhatsNewModalsTab from './AdminWhatsNewModalsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <AdminWhatsNewModalsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );

const modal = (id: string, overrides: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Modal ${id}`,
  enabled: true,
  createdAt: '2026-11-01T00:00:00Z',
  ...overrides,
});

const listResult = (data: unknown[] | undefined, overrides: Record<string, unknown> = {}) => ({
  data,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
  ...overrides,
});

describe('AdminWhatsNewModalsTab', () => {
  beforeEach(() => {
    mocks.modals.mockReset();
    mocks.toggle.mockReset();
    mocks.remove.mockReset();
    mocks.removeAsync.mockReset();
    mocks.create.mockReset();
    mocks.update.mockReset();
    mocks.toggleState = {};
    // A fork stage hides the weekly highlights section; only the last test shows it.
    mocks.deployment.mockReturnValue({ data: { stage: 'production', isForkProduction: true } });
    mocks.highlights.mockReturnValue({ data: undefined, isLoading: false, refetch: vi.fn() });
  });

  it('starts with the page header and lists active modals in the table', () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { enabled: false })]));
    renderTab();

    expect(screen.getByRole('heading', { level: 1, name: "What's New modals" })).toBeInTheDocument();
    expect(screen.getByTestId('whats-new-create-btn')).toBeInTheDocument();
    const table = screen.getByTestId('whats-new-active-table');
    expect(within(table).getByTestId('whats-new-row-a')).toHaveTextContent('Modal a');
    expect(within(table).queryByTestId('whats-new-row-b')).not.toBeInTheDocument();
  });

  it('keeps archived modals collapsed until the section is opened', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b', { enabled: false })]));
    renderTab();

    const toggle = screen.getByTestId('whats-new-archived-toggle-btn');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('whats-new-archived-table')).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(screen.getByTestId('whats-new-archived-table')).getByTestId('whats-new-archived-row-b')
    ).toBeInTheDocument();
  });

  it('disables a modal from its row menu', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-row-actions-a'));
    await userEvent.click(screen.getByTestId('whats-new-row-toggle-a'));

    expect(mocks.toggle).toHaveBeenCalledWith({ modalId: 'a', enabled: false });
  });

  it('marks only the row being toggled as pending', () => {
    mocks.toggleState = { isPending: true, variables: { modalId: 'a', enabled: false } };
    mocks.modals.mockReturnValue(listResult([modal('a'), modal('b')]));
    renderTab();

    expect(screen.getByTestId('whats-new-row-actions-a')).toBeDisabled();
    expect(screen.getByTestId('whats-new-row-actions-b')).toBeEnabled();
  });

  const openDelete = async (id: string) => {
    await userEvent.click(screen.getByTestId(`whats-new-row-actions-${id}`));
    await userEvent.click(screen.getByTestId(`whats-new-row-delete-${id}`));
    await userEvent.click(screen.getByTestId('whats-new-delete-confirm-dialog-reason-input-preset-0'));
  };

  it('deletes a modal only after its title is typed', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    mocks.removeAsync.mockResolvedValue(undefined);
    renderTab();

    await openDelete('a');
    const confirm = screen.getByTestId('whats-new-delete-confirm-btn');
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId('whats-new-delete-confirm-dialog-typed-input'), 'Modal');
    expect(confirm).toBeDisabled();
    expect(mocks.removeAsync).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('whats-new-delete-confirm-dialog-typed-input'), ' a');
    await userEvent.click(confirm);
    expect(mocks.removeAsync).toHaveBeenCalledWith('a');
    expect(screen.queryByTestId('whats-new-delete-confirm-dialog')).not.toBeInTheDocument();
  });

  it('asks for the word delete when the modal has no title', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a', { title: '  ' })]));
    mocks.removeAsync.mockResolvedValue(undefined);
    renderTab();

    await openDelete('a');
    await userEvent.type(screen.getByTestId('whats-new-delete-confirm-dialog-typed-input'), 'delete');
    await userEvent.click(screen.getByTestId('whats-new-delete-confirm-btn'));
    expect(mocks.removeAsync).toHaveBeenCalledWith('a');
  });

  it('keeps the delete dialog open when the delete fails', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    mocks.removeAsync.mockRejectedValue(new Error('boom'));
    renderTab();

    await openDelete('a');
    await userEvent.type(screen.getByTestId('whats-new-delete-confirm-dialog-typed-input'), 'Modal a');
    await userEvent.click(screen.getByTestId('whats-new-delete-confirm-btn'));
    expect(mocks.removeAsync).toHaveBeenCalledWith('a');
    expect(screen.getByTestId('whats-new-delete-confirm-dialog')).toBeInTheDocument();
  });

  it('offers to create the first modal when there are none', async () => {
    mocks.modals.mockReturnValue(listResult([]));
    renderTab();

    expect(screen.getByText('No modals yet')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('whats-new-empty-create-btn'));
    expect(screen.getByTestId('whats-new-create-dialog')).toBeInTheDocument();
  });

  it('shows the create form end date as unset until a date is added', async () => {
    mocks.modals.mockReturnValue(listResult([]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-empty-create-btn'));
    expect(screen.getByTestId('whats-new-create-enddate-input-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('whats-new-create-enddate-input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('whats-new-create-enddate-input-set-btn'));
    expect(screen.getByTestId('whats-new-create-enddate-input')).toHaveValue(getLocalDate(30));
  });

  it('creates a modal without an end date while the date is unset', async () => {
    mocks.modals.mockReturnValue(listResult([]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-empty-create-btn'));
    await userEvent.type(screen.getByTestId('whats-new-create-title-input'), 'Title');
    await userEvent.type(screen.getByTestId('whats-new-create-description-input'), 'Body');
    await userEvent.click(screen.getByTestId('whats-new-create-submit-btn'));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].endDate).toBeUndefined();
  });

  it('shows the edit form end date as unset for a modal without one', async () => {
    mocks.modals.mockReturnValue(listResult([modal('a', { description: 'Body' })]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-row-actions-a'));
    await userEvent.click(screen.getByTestId('whats-new-row-edit-a'));
    expect(screen.getByTestId('whats-new-edit-enddate-input-empty')).toHaveTextContent('No end date');
    expect(screen.queryByTestId('whats-new-edit-enddate-input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('whats-new-edit-submit-btn'));
    expect(mocks.update.mock.calls[0][0].updates.endDate).toBeUndefined();
  });

  it('removes an existing end date from the edit form', async () => {
    // Midday UTC so the stored instant is the same calendar day in every zone.
    mocks.modals.mockReturnValue(listResult([modal('a', { description: 'Body', endDate: '2027-03-01T12:00:00Z' })]));
    renderTab();

    await userEvent.click(screen.getByTestId('whats-new-row-actions-a'));
    await userEvent.click(screen.getByTestId('whats-new-row-edit-a'));
    expect(screen.getByTestId('whats-new-edit-enddate-input')).toHaveValue('2027-03-01');

    await userEvent.click(screen.getByTestId('whats-new-edit-enddate-input-clear-btn'));
    expect(screen.getByTestId('whats-new-edit-enddate-input-empty')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('whats-new-edit-submit-btn'));
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ modalId: 'a' });
    expect(mocks.update.mock.calls[0][0].updates.endDate).toBeUndefined();
  });

  it('shows a retryable error when the modals fail to load', async () => {
    const result = listResult(undefined, { isError: true });
    mocks.modals.mockReturnValue(result);
    renderTab();

    await userEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(result.refetch).toHaveBeenCalled();
  });

  it('shows the weekly highlights section below the modals on a main environment', () => {
    mocks.deployment.mockReturnValue({ data: { stage: 'dev', isForkProduction: false } });
    mocks.highlights.mockReturnValue({
      data: { enabled: true, slackChannelId: 'C1', slackTeamId: 'T1' },
      isLoading: false,
      refetch: vi.fn(),
    });
    mocks.modals.mockReturnValue(listResult([modal('a')]));
    renderTab();

    const section = screen.getByTestId('whats-new-highlights');
    expect(within(section).getByRole('heading', { level: 2, name: 'Weekly highlights to Slack' })).toBeInTheDocument();
    expect(within(section).getByTestId('highlights-status-chip')).toHaveTextContent('Enabled');
    expect(within(section).getByTestId('highlights-run-now-btn')).toBeEnabled();
  });
});
