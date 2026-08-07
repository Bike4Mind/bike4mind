import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { DataLakeSettingsModal } from './DataLakeSettingsModal';

const updateMutate = vi.fn();
const visibilityMutate = vi.fn();
const warn = vi.fn();

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useUpdateDataLake: () => ({ mutate: updateMutate, isPending: false }),
  useSetLakeVisibility: () => ({ mutate: visibilityMutate, isPending: false }),
}));

// The picker's options come from an async react-query hook. Mock it so the modal renders
// without a QueryClientProvider, and so each test can control the two states that matter:
// options not-yet-arrived (data undefined, isLoading true) vs loaded. The seed/read-back bug
// lives entirely in that timing, so the mock IS the seam under test.
type MockActivatable = { promptId: string; name: string; description: string };
let activatablePrompts: MockActivatable[] | undefined;
let activatableLoading = false;
vi.mock('@client/app/hooks/data/useActivatablePrompts', () => ({
  useActivatablePrompts: () => ({ data: activatablePrompts, isLoading: activatableLoading }),
}));

const TRIAGE_ROUTER: MockActivatable = {
  promptId: 'triage_router',
  name: 'Triage Router',
  description: 'Grounding-first routing prompt.',
};

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

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// Steady state for the tests that don't care about the picker: allowlist loaded, router present.
// The preferred-prompt suite below overrides these per test to exercise the load-timing edges.
beforeEach(() => {
  activatablePrompts = [TRIAGE_ROUTER];
  activatableLoading = false;
});

const gatedLake = {
  id: 'lake-1',
  name: 'Test Lake',
  description: 'desc',
  requiredUserTag: 'Opti',
  requiredEntitlement: '',
  organizationId: '',
  isPublic: false,
  systemPrompt: '',
  preferredSystemPromptId: '',
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
  preferredSystemPromptId: '',
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
  preferredSystemPromptId: '',
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

  // EditableLake types systemPrompt as a required string, but that's a caller contract, not
  // a runtime guarantee - a caller that forgets to normalize a server response missing this
  // field would otherwise hand the modal `undefined` here. Pins the fallback, not just the
  // typical '' case: without it, the character-count helper text below crashes on `.trim()`.
  it("seeds an empty field when the lake's systemPrompt is missing, without rendering 'undefined'", () => {
    const lakeWithoutPrompt = { ...promptedLake, systemPrompt: undefined as unknown as string };
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={lakeWithoutPrompt} onClose={vi.fn()} />
      </Wrapper>
    );

    const textarea = screen.getByTestId('datalake-systemprompt-input').querySelector('textarea')!;
    expect(textarea).toHaveValue('');
  });
});

describe('DataLakeSettingsModal \u2014 preferred prompt binding', () => {
  const boundLake = { ...openLake, id: 'lake-6', preferredSystemPromptId: 'triage_router' };

  beforeEach(() => {
    updateMutate.mockReset();
  });

  // The data-loss regression: the bound prompt's <Option> comes from an async allowlist, so on
  // the first Settings-open it is not in the DOM yet. A controlled Joy Select with no option
  // matching its value resolves the value to '' and fires onChange, so a Save that never touched
  // the picker used to silently clear the binding. Saving an untouched picker must round-trip.
  it('preserves the bound prompt on save when the allowlist has not loaded yet', async () => {
    activatablePrompts = undefined;
    activatableLoading = true;
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={boundLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ preferredSystemPromptId: 'triage_router' });
  });

  it('preserves the bound prompt on save once the allowlist has loaded', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={boundLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ preferredSystemPromptId: 'triage_router' });
  });

  // A bound prompt an admin later removed from the allowlist must not be silently dropped either:
  // the fallback <Option> keeps the Select holding the value so an untouched save preserves it.
  it('preserves a bound prompt that is no longer in the allowlist', async () => {
    activatablePrompts = [];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={boundLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate.mock.calls[0][0]).toMatchObject({ preferredSystemPromptId: 'triage_router' });
  });

  it('sends the empty clear-sentinel when an editor selects None', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={boundLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-preferred-prompt-button'));
    await user.click(screen.getByTestId('datalake-preferred-prompt-none'));
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    // '' is the deliberate clear here (an editor chose None), as opposed to the accidental ''
    // the first-open bug produced - the value the user actually picked round-trips.
    expect(updateMutate.mock.calls[0][0]).toMatchObject({ preferredSystemPromptId: '' });
  });

  it('binds a prompt when an editor picks one on a None lake', async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={openLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-preferred-prompt-button'));
    await user.click(screen.getByTestId('datalake-preferred-prompt-triage_router'));
    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate.mock.calls[0][0]).toMatchObject({ preferredSystemPromptId: 'triage_router' });
  });

  it('never sends preferredSystemPromptId from a non-editor save', async () => {
    const readerLake = { ...boundLake, id: 'lake-7', canManage: false };
    const user = userEvent.setup();
    render(
      <Wrapper>
        <DataLakeSettingsModal lake={readerLake} onClose={vi.fn()} />
      </Wrapper>
    );

    await user.click(screen.getByTestId('datalake-settings-save-btn'));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).not.toHaveProperty('preferredSystemPromptId');
  });
});
