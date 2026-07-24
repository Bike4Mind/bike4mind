import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DataLakeListPanel, { DataLakeSettingsModal } from './DataLakeListPanel';

const updateMutate = vi.fn();
const visibilityMutate = vi.fn();
const warn = vi.fn();

vi.mock('@client/app/hooks/data/dataLakes', () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useUpdateDataLake: () => ({ mutate: updateMutate, isPending: false }),
    useSetLakeVisibility: () => ({ mutate: visibilityMutate, isPending: false }),
    useArchiveDataLake: mutation,
    useUnarchiveDataLake: mutation,
    useRestoreDeletedDataLake: mutation,
    usePermanentDeleteDataLake: mutation,
    useCleanupDataLake: mutation,
    useGetArchivedDataLakes: () => ({ data: undefined }),
    useGetDeletedDataLakes: () => ({ data: undefined }),
    useBrowsePublicDataLakes: () => ({
      data: { data: [], total: 0 },
      isLoading: false,
      isFetching: false,
      isError: false,
    }),
  };
});

const useDataLakes = vi.fn(() => ({ data: [] as unknown[], isLoading: false }));
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useDataLakes: () => useDataLakes(),
}));

// Default (flag on) is established per-describe; tests override per-case.
const isFeatureEnabled = vi.fn();
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled }),
}));

// The settings modal derives org-visibility state from the account switcher (useAccounts),
// which internally uses react-query - stub it so these clear-tag tests don't need a
// QueryClientProvider. No org / no selection -> the Organization toggle is simply disabled,
// which is irrelevant to the access-gate assertions below.
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useAccounts: () => ({ accounts: [], selectedAccount: null }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: (...a: unknown[]) => warn(...a) },
}));

// Keep the sibling viewer import light - it isn't rendered by the settings modal.
vi.mock('./DataLakeViewer', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const gatedLake = {
  id: 'lake-1',
  name: 'Test Lake',
  description: 'desc',
  requiredUserTag: 'Opti',
  requiredEntitlement: '',
  organizationId: '',
  isPublic: false,
};

const openLake = {
  id: 'lake-2',
  name: 'Open Lake',
  description: 'desc',
  requiredUserTag: '',
  requiredEntitlement: '',
  organizationId: '',
  isPublic: false,
};

describe('DataLakeSettingsModal — clearing an access gate', () => {
  beforeEach(() => {
    updateMutate.mockReset();
    warn.mockReset();
  });

  it('warns and skips the no-op update when blanking the tag is the only change', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={onClose} />
      </Wrapper>
    );

    await user.clear(screen.getByPlaceholderText('e.g. Opti'));
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    // Explicit message surfaced (the fix), not a silent success.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/cleared/i);
    expect(warn.mock.calls[0][0]).toMatch(/tag was kept/i);
    // Clearing is the only change -> skip the no-op update (avoids a contradictory success toast).
    expect(updateMutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('warns but still saves when the tag is blanked alongside another change', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.clear(screen.getByPlaceholderText('e.g. Opti'));
    const nameInput = screen.getByTestId('datalake-settings-name').querySelector('input')!;
    await user.clear(nameInput);
    await user.type(nameInput, 'Renamed Lake');
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(warn).toHaveBeenCalledTimes(1);
    // Real change persists; the blanked gate is omitted so the backend keeps it.
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ name: 'Renamed Lake' });
    expect(updateMutate.mock.calls[0][0]).not.toHaveProperty('requiredUserTag');
  });

  it('does not warn when the access tag is unchanged', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(warn).not.toHaveBeenCalled();
    expect(updateMutate).toHaveBeenCalledTimes(1);
    // Unchanged gate is still sent so it's preserved.
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ requiredUserTag: 'Opti' });
  });
});

describe('DataLakeSettingsModal — public visibility', () => {
  beforeEach(() => {
    visibilityMutate.mockReset();
  });

  it('disables the Public option for a gated lake (a gate can’t be exposed app-wide)', () => {
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={vi.fn()} />
      </Wrapper>
    );
    expect(screen.getByRole('radio', { name: 'Public' })).toBeDisabled();
  });

  it('selecting Public opens an explicit confirm and does NOT publish until confirmed', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={openLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByRole('radio', { name: 'Public' }));
    // The radio only arms the confirm dialog - it must not fire the mutation on its own.
    expect(visibilityMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('datalake-publish-confirm')).toBeInTheDocument();

    await user.click(screen.getByTestId('datalake-publish-confirm-btn'));
    expect(visibilityMutate).toHaveBeenCalledTimes(1);
    expect(visibilityMutate.mock.calls[0][0]).toMatchObject({ id: 'lake-2', visibility: 'public' });
  });

  it('cancelling the confirm leaves the lake unpublished', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={openLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByRole('radio', { name: 'Public' }));
    const confirm = screen.getByTestId('datalake-publish-confirm');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));

    expect(visibilityMutate).not.toHaveBeenCalled();
  });
});

describe('DataLakeListPanel - EnableDataLakes gating', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
  });

  it('renders the panel when the feature is on', () => {
    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-list-panel')).toBeInTheDocument();
  });

  it('renders nothing when the feature is off (shared choke point for every manager entry)', () => {
    isFeatureEnabled.mockImplementation((key: string) => key !== 'EnableDataLakes');

    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    // The panel's lakes queries 403 when the feature is off, and its empty state
    // is a dead end - so the panel must not render at all, mirroring
    // SendToDataLakeModal's render guard.
    expect(screen.queryByTestId('datalake-list-panel')).not.toBeInTheDocument();
  });
});

describe('DataLakeListPanel - persistent Data Lakes info tooltip (#834)', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useDataLakes.mockReset();
    useDataLakes.mockReturnValue({ data: [], isLoading: false });
  });

  it('shows a persistent info icon next to the header that reveals the RAG explanation on hover', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    // Always present next to the header - not a one-time dismissable callout.
    const trigger = screen.getByTestId('field-tooltip-data-lake-panel');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Help: Data Lakes');

    await user.hover(trigger);
    expect(
      await screen.findByText(/curated knowledge base the AI grounds its answers in \(RAG\)/i)
    ).toBeInTheDocument();
  });
});

describe('DataLakeListPanel - management affordances gate on canManage', () => {
  beforeEach(() => {
    isFeatureEnabled.mockReset();
    isFeatureEnabled.mockReturnValue(true);
    useDataLakes.mockReset();
  });

  const listLake = (over: Record<string, unknown>) => ({
    id: 'lk',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    ...over,
  });

  it('shows Add files / Settings / Archive on a lake the caller can manage', () => {
    useDataLakes.mockReturnValue({
      data: [listLake({ id: 'mine', name: 'Mine', canManage: true })],
      isLoading: false,
    });

    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-addfiles-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-settings-btn-mine')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-archive-btn-mine')).toBeInTheDocument();
  });

  it("hides all three on a lake the caller cannot manage (someone else's public lake)", () => {
    useDataLakes.mockReturnValue({
      data: [listLake({ id: 'theirs', name: 'Theirs', isPublic: true, canManage: false })],
      isLoading: false,
    });

    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    // The read-only row still renders (and opens the viewer on click) - only the
    // management affordances are gated.
    expect(screen.getByTestId('datalake-card-theirs')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-addfiles-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-settings-btn-theirs')).toBeNull();
    expect(screen.queryByTestId('datalake-archive-btn-theirs')).toBeNull();
  });
});
