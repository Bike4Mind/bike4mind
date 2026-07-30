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
      data: { pages: [{ data: [], total: 0 }] },
      isLoading: false,
      isFetchingNextPage: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
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
  systemPrompt: '',
  canManage: true,
};

const openLake = {
  id: 'lake-2',
  name: 'Open Lake',
  description: 'desc',
  requiredUserTag: '',
  requiredEntitlement: '',
  organizationId: '',
  isPublic: false,
  systemPrompt: '',
  canManage: true,
};

const entitlementGatedLake = {
  id: 'lake-3',
  name: 'Entitled Lake',
  description: 'desc',
  requiredUserTag: '',
  requiredEntitlement: 'product:pro',
  organizationId: '',
  isPublic: false,
  systemPrompt: '',
  canManage: true,
};

describe('DataLakeSettingsModal — clearing an access gate', () => {
  beforeEach(() => {
    updateMutate.mockReset();
    warn.mockReset();
  });

  it('sends the empty clear-sentinel when the tag is blanked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={onClose} />
      </Wrapper>
    );

    await user.clear(screen.getByPlaceholderText('e.g. Opti'));
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    // '' is what tells the backend to remove the gate - omitting the field would be
    // "leave unchanged", which is what made a mis-gated lake unfixable.
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ id: 'lake-1', requiredUserTag: '' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends the empty clear-sentinel when the entitlement is blanked', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={entitlementGatedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.clear(screen.getByPlaceholderText('e.g. product:pro'));
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    // Same sentinel contract as the tag gate - '' clears, an omitted field would leave it unchanged.
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ id: 'lake-3', requiredEntitlement: '' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns in-form what clearing the gate leaves the lake reachable by', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    expect(screen.getByTestId('datalake-settings-usertag-help')).toHaveTextContent(/must hold this tag/i);
    await user.clear(screen.getByPlaceholderText('e.g. Opti'));
    expect(screen.getByTestId('datalake-settings-usertag-help')).toHaveTextContent(/removes the “Opti” gate/i);
    expect(screen.getByTestId('datalake-settings-usertag-help')).toHaveTextContent(/follows Visibility/i);
  });

  it('clears the tag alongside another change in one save', async () => {
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

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ name: 'Renamed Lake', requiredUserTag: '' });
  });

  it('preserves an untouched gate on save', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={gatedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
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

describe('DataLakeSettingsModal — per-lake system prompt', () => {
  const promptedLake = { ...openLake, id: 'lake-4', systemPrompt: 'Always cite the source file.' };
  // What a NON-EDITOR receives: canManage false. The prompt text is carried here deliberately -
  // the server withholds it (listDataLakes only sends it to editors), so this fixture is the
  // belt-and-braces case, asserting the UI would not render the wording even if it arrived.
  const readOnlyLake = {
    ...openLake,
    id: 'lake-5',
    name: 'Shared Lake',
    isPublic: true,
    systemPrompt: 'INTERNAL-ONLY-PROMPT-TEXT',
    canManage: false,
  };

  beforeEach(() => {
    updateMutate.mockReset();
  });

  it('seeds the field from the lake and sends the trimmed value on save', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={promptedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    const textarea = screen.getByTestId('datalake-systemprompt-input').querySelector('textarea')!;
    expect(textarea).toHaveValue('Always cite the source file.');

    await user.clear(textarea);
    await user.type(textarea, '  Answer only from these documents.  ');
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({
      id: 'lake-4',
      systemPrompt: 'Answer only from these documents.',
    });
  });

  it('sends the empty clear-sentinel when an editor blanks the prompt', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={promptedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.clear(screen.getByTestId('datalake-systemprompt-input').querySelector('textarea')!);
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    // '' unsets the prompt; omitting the field would mean "leave unchanged".
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ systemPrompt: '' });
  });

  it('states that the org prompt wins and that the text is editors-only', () => {
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={promptedLake} onClose={vi.fn()} />
      </Wrapper>
    );

    const help = screen.getByTestId('datalake-systemprompt-help');
    expect(help).toHaveTextContent(/organization's prompt stays authoritative/i);
    expect(help).toHaveTextContent(/only people who can manage this lake can read this text/i);
  });

  // The QA carry-forward from PR 1: a user who can only READ a shared/public lake must never
  // see the wording of its prompt, only its effect on answers.
  it('NEVER shows the prompt to a non-editor on a shared/public lake', () => {
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={readOnlyLake} onClose={vi.fn()} />
      </Wrapper>
    );

    // The modal itself opened (so this is a real negative, not an unrendered tree).
    expect(screen.getByTestId('datalake-settings-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-systemprompt-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-systemprompt-help')).not.toBeInTheDocument();
    expect(screen.queryByText(/System prompt/i)).not.toBeInTheDocument();
    // The wording must appear nowhere in the rendered modal - not in a form control either.
    // Read the live values, not a [value=...] attribute selector: React sets a textarea's value
    // as a DOM property, so an attribute match would be null whether or not the field rendered.
    expect(screen.getByTestId('datalake-settings-modal').textContent).not.toMatch(/INTERNAL-ONLY-PROMPT-TEXT/);
    const fieldValues = [
      ...Array.from(document.querySelectorAll('textarea')).map(el => el.value),
      ...Array.from(document.querySelectorAll('input')).map(el => el.value),
    ];
    expect(fieldValues).not.toContain('INTERNAL-ONLY-PROMPT-TEXT');
  });

  it('omits systemPrompt from a non-editor save, so it cannot wipe an unseen prompt', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={readOnlyLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).not.toHaveProperty('systemPrompt');
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

  // The seam between the server's response and the modal's props. Every other prompt test
  // renders DataLakeSettingsModal directly with a hand-built object, so nothing else would
  // catch the panel dropping systemPrompt or hard-coding canManage on the way through.
  it('carries systemPrompt and canManage from the list response into the settings modal', async () => {
    const user = userEvent.setup();
    useDataLakes.mockReturnValue({
      data: [listLake({ id: 'mine', name: 'Mine', canManage: true, systemPrompt: 'Cite the source file.' })],
      isLoading: false,
    });

    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-btn-mine'));

    const textarea = screen.getByTestId('datalake-systemprompt-input').querySelector('textarea')!;
    expect(textarea).toHaveValue('Cite the source file.');
  });

  // The server OMITS the key for a non-editor; the modal state is a string. This pins the
  // absent -> '' mapping, so a lake with no readable prompt cannot render `undefined`.
  it("seeds an empty field when the server withheld the prompt, without rendering 'undefined'", async () => {
    const user = userEvent.setup();
    useDataLakes.mockReturnValue({
      data: [listLake({ id: 'mine', name: 'Mine', canManage: true })],
      isLoading: false,
    });

    render(
      <Wrapper>
        <DataLakeListPanel />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-btn-mine'));

    const textarea = screen.getByTestId('datalake-systemprompt-input').querySelector('textarea')!;
    expect(textarea).toHaveValue('');
  });
});
