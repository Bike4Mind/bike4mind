import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore, type WizardTargetLake } from '@client/app/stores/useDataLakeWizardStore';
import SourceSelectionStep from './SourceSelectionStep';

const { lakes, selectedAccount, toastInfo, organizations, gitHubFlag, slugPreview, slugPreviewMock } = vi.hoisted(
  () => {
    const slugPreview = { current: undefined as string | undefined };
    return {
      lakes: { current: [] as { id: string; name: string; organizationId?: string }[] },
      selectedAccount: { current: { id: 'me', personal: true } as { id: string; personal: boolean } | null },
      toastInfo: vi.fn(),
      organizations: { current: [] as { id: string; userId: string; managerId?: string }[] },
      gitHubFlag: { current: true },
      slugPreview,
      slugPreviewMock: vi.fn((_name: string, _enabled: boolean) => ({
        data: slugPreview.current === undefined ? undefined : { slug: slugPreview.current, tagPrefix: null },
      })),
    };
  }
);

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: lakes.current }),
  activeOrgId: () => undefined,
  useDataLakeSlugPreview: (name: string, _tagPrefix: string | undefined, enabled: boolean) =>
    slugPreviewMock(name, enabled),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: selectedAccount.current }),
}));
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));
// The cards resolve their scope from the account switcher plus the caller's rung on the selected
// org. Mocked at those two reads rather than at useCreateLakeScope, so the real derivation (and the
// real owner/manager predicate behind it) runs here instead of being stubbed over.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isAdminFeatureEnabled: (key: string) => key !== 'EnableDataLakeGitHub' || gitHubFlag.current,
    isFeatureEnabled: vi.fn(),
    isLoading: false,
  }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: { currentUser: unknown }) => unknown) => selector({ currentUser: { id: 'me' } }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ data: organizations.current }),
}));
// The GitHub panel's own behaviour is covered by GitHubCreatePanel.test.tsx; here it is a marker,
// so these tests assert WHICH screen the step shows - the gate this component owns.
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubCreatePanel', () => ({
  default: ({ organizationId }: { organizationId: string }) => (
    <div data-testid="github-create-panel" data-org={organizationId} />
  ),
}));
// The source actions pull in React Query (useConfig / lake-connection hooks); stub them so these
// step-order/name-validation tests need no QueryClientProvider. Their own behavior is covered by
// LakeSourceConnectActions.test.tsx and DrivePendingConnectAction.test.tsx.
// Rendered as markers rather than null: these tests assert WHICH of the two appears, which is the
// gate this step owns. Their own behaviour stays covered by their own test files.
vi.mock('@client/app/components/DataLakeWizard/steps/LakeSourceConnectActions', () => ({
  default: () => <div data-testid="lake-source-connect-actions" />,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/DrivePendingConnectAction', () => ({
  default: () => <div data-testid="drive-pending-connect-action" />,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderStep = () =>
  render(
    <TestWrapper>
      <SourceSelectionStep />
    </TestWrapper>
  );

const setName = (name: string) => useDataLakeWizardStore.setState(state => ({ config: { ...state.config, name } }));

/** Every test below the cards starts from a chosen source, as the user would. */
const pickSource = (kind: 'upload' | 'googleDrive' | 'github') =>
  useDataLakeWizardStore.getState().setCreateSource(kind);

/** The account-switcher scope the create will land in, which is what gates the GitHub card. */
const asOrgOwner = () => {
  selectedAccount.current = { id: 'org-1', personal: false };
  organizations.current = [{ id: 'org-1', userId: 'me' }];
};
const asOrgMember = () => {
  selectedAccount.current = { id: 'org-1', personal: false };
  organizations.current = [{ id: 'org-1', userId: 'someone-else' }];
};

/** Drive the hidden file input the way a picker selection would. */
const selectFiles = (container: HTMLElement, files: File[]) => {
  const inputs = container.querySelectorAll('input[type="file"]');
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
};

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });

beforeEach(() => {
  lakes.current = [];
  // Personal by default, as the pre-existing name/duplicate tests below assume.
  selectedAccount.current = { id: 'me', personal: true };
  organizations.current = [];
  gitHubFlag.current = true;
  toastInfo.mockClear();
  slugPreview.current = undefined;
  slugPreviewMock.mockClear();
  // The source question is asked first now, so every test that is not ABOUT the cards answers it.
  pickSource('upload');
});

afterEach(() => {
  vi.useRealTimers();
  useDataLakeWizardStore.getState().resetWizard();
});

/**
 * "Where's your content?" is the first question the create wizard asks (#3817). The cards come from
 * the create-source registry, so visibility and the disabled reasons are asserted here as the user
 * meets them; the registry's own rules are pinned in createLakeSources.test.ts.
 */
describe('SourceSelectionStep - the source cards', () => {
  const showCards = () => useDataLakeWizardStore.getState().setCreateSource(null);

  it('asks where the content is before anything else, with no name field yet', () => {
    showCards();
    renderStep();

    expect(screen.getByText("Where's your content?")).toBeInTheDocument();
    // Naming comes after the source: the answer decides what the rest of the step even asks for.
    expect(screen.queryByTestId('source-name-input')).toBeNull();
    expect(screen.queryByTestId('wizard-upload-btn')).toBeNull();
  });

  it('offers all three cards to an org owner/manager', () => {
    asOrgOwner();
    showCards();
    renderStep();

    expect(screen.getByTestId('create-source-card-upload')).toBeEnabled();
    expect(screen.getByTestId('create-source-card-googleDrive')).toBeEnabled();
    expect(screen.getByTestId('create-source-card-github')).toBeEnabled();
  });

  it('configures the folder picker when Upload mounts after the source cards', () => {
    useDataLakeWizardStore.getState().openWizard();
    renderStep();

    fireEvent.click(screen.getByTestId('create-source-card-upload'));

    expect(screen.getByTestId('wizard-folder-input')).toHaveAttribute('webkitdirectory', '');
    expect(screen.getByTestId('wizard-folder-input')).toHaveAttribute('directory', '');
  });

  it('hides GitHub entirely while EnableDataLakeGitHub is off', () => {
    asOrgOwner();
    gitHubFlag.current = false;
    showCards();
    renderStep();

    expect(screen.queryByTestId('create-source-card-github')).toBeNull();
    expect(screen.getByTestId('create-source-card-upload')).toBeInTheDocument();
    expect(screen.getByTestId('create-source-card-googleDrive')).toBeInTheDocument();
  });

  it('shows GitHub disabled with its reason in a personal workspace', () => {
    showCards();
    renderStep();

    expect(screen.getByTestId('create-source-card-github')).toBeDisabled();
    expect(screen.getByTestId('create-source-reason-github')).toHaveTextContent('organization');
  });

  it('shows GitHub disabled with its reason for a non-manager of the org', () => {
    asOrgMember();
    showCards();
    renderStep();

    expect(screen.getByTestId('create-source-card-github')).toBeDisabled();
    expect(screen.getByTestId('create-source-reason-github')).toHaveTextContent('owner or manager');
  });

  it('does not record a source when a disabled card is clicked', () => {
    showCards();
    renderStep();

    fireEvent.click(screen.getByTestId('create-source-card-github'));

    expect(useDataLakeWizardStore.getState().createSource).toBeNull();
    expect(screen.queryByTestId('github-create-panel')).toBeNull();
  });

  it.each([
    ['upload', 'curated'],
    ['googleDrive', 'connector-fed'],
  ] as const)('records %s on the store, which the create sends as origin %s', kind => {
    showCards();
    renderStep();

    fireEvent.click(screen.getByTestId(`create-source-card-${kind}`));

    expect(useDataLakeWizardStore.getState().createSource).toBe(kind);
  });

  it('opens the GitHub panel for the selected organization', () => {
    asOrgOwner();
    showCards();
    renderStep();

    fireEvent.click(screen.getByTestId('create-source-card-github'));

    expect(screen.getByTestId('github-create-panel')).toHaveAttribute('data-org', 'org-1');
  });

  it('does not mount the GitHub panel if a stale selection is no longer available', () => {
    asOrgOwner();
    pickSource('github');
    gitHubFlag.current = false;

    renderStep();

    expect(screen.queryByTestId('github-create-panel')).toBeNull();
    expect(screen.getByTestId('create-source-cards')).toBeInTheDocument();
  });

  it('returns to the cards from a chosen source, dropping what it had gathered', () => {
    const { container } = renderStep();
    selectFiles(container, [file('a.txt')]);
    expect(useDataLakeWizardStore.getState().allFiles).toHaveLength(1);

    fireEvent.click(screen.getByTestId('source-change-btn'));

    // A file picked under Upload must not survive into a lake created for a connector.
    expect(useDataLakeWizardStore.getState().createSource).toBeNull();
    expect(useDataLakeWizardStore.getState().allFiles).toEqual([]);
    expect(screen.getByText("Where's your content?")).toBeInTheDocument();
  });

  it('never asks the source question in append mode - the lake already has an origin', () => {
    useDataLakeWizardStore.setState({
      createSource: null,
      targetLake: {
        id: 'lake-1',
        name: 'Niche',
        slug: 'niche',
        fileTagPrefix: 'niche:',
        organizationId: 'org-1',
        canManage: true,
      } as WizardTargetLake,
    });

    renderStep();

    expect(screen.queryByTestId('create-source-cards')).toBeNull();
    expect(screen.getByTestId('wizard-upload-btn')).toBeInTheDocument();
  });
});

/**
 * A connector feeds the lake itself, so it must never demand an upload - that demand is what made a
 * connector-only lake impossible before (#1916), and the card now states the intent up front.
 */
describe('SourceSelectionStep - per-source chrome', () => {
  it('asks for files, and not for Drive, under the Upload card', () => {
    renderStep();

    expect(screen.getByTestId('wizard-upload-btn')).toBeInTheDocument();
    expect(screen.getByText('Drop files or a folder here')).toBeInTheDocument();
    expect(screen.queryByTestId('drive-pending-connect-action')).toBeNull();
  });

  it('offers the Drive picker, and no upload control, under the Drive card', () => {
    pickSource('googleDrive');
    renderStep();

    expect(screen.getByTestId('drive-pending-connect-action')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-upload-btn')).toBeNull();
    expect(screen.queryByText('Drop files or a folder here')).toBeNull();
  });

  it('still asks both halves to name the lake', () => {
    pickSource('googleDrive');
    renderStep();

    expect(screen.getByTestId('source-name-input')).toBeInTheDocument();
  });
});

/**
 * Identity moved here from Config (#824): the user names the lake before committing files,
 * so the duplicate-name and slug hints have to move with the field.
 */
describe('SourceSelectionStep - lake name', () => {
  const WARNING = 'source-name-duplicate-warning';
  const SLUG_ERROR = 'source-name-slug-error';
  const SLUG = 'source-name-slug';

  it('warns when a personal lake already uses the name, ignoring case and padding', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche' }];
    setName('  niche ');

    renderStep();

    expect(screen.getByTestId(WARNING)).toHaveTextContent('Niche');
  });

  it('stays silent when no name matches', () => {
    lakes.current = [{ id: 'lake-1', name: 'Other Lake' }];
    setName('Niche');

    renderStep();

    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('stays silent for a same-named lake outside the active scope', () => {
    // The server disambiguates slugs per-org, so a same-named lake elsewhere is no collision.
    lakes.current = [{ id: 'lake-1', name: 'Niche', organizationId: 'org-a' }];
    setName('Niche');

    renderStep();

    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('warns on a same-named lake in the active org when an org is selected', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche', organizationId: 'org-a' }];
    selectedAccount.current = { id: 'org-a', personal: false };
    setName('Niche');

    renderStep();

    expect(screen.getByTestId(WARNING)).toBeInTheDocument();
  });

  it('flags a name that slugifies too short (below the server 2-char minimum)', () => {
    setName('!!');

    renderStep();

    // Asserts the TEXT, not just the element: the minimum is interpolated into this copy from
    // MIN_DATA_LAKE_SLUG_LENGTH, which the component imports from @bike4mind/common. If that
    // ever resolved to undefined the sentence would read "at least  letters" and a presence-only
    // check would still pass, which is the one way this shared bound can break a user-facing string.
    expect(screen.getByTestId(SLUG_ERROR)).toHaveTextContent('This name needs at least 2 letters or numbers');
  });

  it('stays silent for a name that yields a valid slug', () => {
    setName('Legal Contracts');

    renderStep();

    expect(screen.queryByTestId(SLUG_ERROR)).toBeNull();
    expect(screen.getByText('legal-contracts')).toBeInTheDocument();
  });

  it('stays silent for an empty name (no nagging before the user types)', () => {
    setName('');

    renderStep();

    expect(screen.queryByTestId(SLUG_ERROR)).toBeNull();
  });

  it('shows the server slug preview, matching the Config summary', () => {
    // A lake (possibly deleted) already holds "niche", so create would mint "niche-1".
    slugPreview.current = 'niche-1';
    setName('Niche');

    renderStep();

    expect(screen.getByTestId(SLUG)).toHaveTextContent('niche-1');
  });

  it('falls back to the local slug while the preview is loading or has failed', () => {
    setName('Legal Contracts');

    renderStep();

    expect(screen.getByTestId(SLUG)).toHaveTextContent('legal-contracts');
  });

  it('keeps the slug of the lake a same-prefix retry will restore, not the preview', () => {
    slugPreview.current = 'legal-contracts-1';
    useDataLakeWizardStore.setState(state => ({
      config: { ...state.config, name: 'Legal Contracts', tagPrefix: 'legal:' },
    }));
    useDataLakeWizardStore.setState({ recoverableLake: { id: 'lake1', tagPrefix: 'legal:', slug: 'legal-contracts' } });

    renderStep();

    expect(screen.getByTestId(SLUG)).toHaveTextContent(/^legal-contracts$/);
  });

  it('queries the preview with the settled name, not on every keystroke', () => {
    vi.useFakeTimers();
    slugPreview.current = 'abc-1';
    renderStep();
    const input = screen.getByTestId('source-name-input').querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'A' } });
    fireEvent.change(input, { target: { value: 'Ab' } });
    fireEvent.change(input, { target: { value: 'Abc' } });

    // The preview of an older (empty) name is never shown in place of the typed one.
    expect(screen.getByTestId(SLUG)).toHaveTextContent(/^abc$/);
    expect(slugPreviewMock.mock.calls.filter(([, enabled]) => enabled)).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(300);
    });

    const enabledNames = slugPreviewMock.mock.calls.filter(([, enabled]) => enabled).map(([name]) => name);
    expect(enabledNames.length).toBeGreaterThan(0);
    expect(enabledNames.every(name => name === 'Abc')).toBe(true);
    expect(screen.getByTestId(SLUG)).toHaveTextContent('abc-1');
  });

  it('does not query the preview for a name that cannot form a slug', () => {
    setName('!');

    renderStep();

    expect(slugPreviewMock.mock.calls.filter(([, enabled]) => enabled)).toEqual([]);
    expect(screen.getByTestId('source-name-slug-error')).toBeInTheDocument();
  });

  it('offers no name field in append mode - the target lake owns its identity', () => {
    useDataLakeWizardStore.setState({
      targetLake: {
        id: 'lake-1',
        name: 'Niche',
        slug: 'niche',
        fileTagPrefix: 'niche:',
        organizationId: 'org-1',
        canManage: true,
      },
    });

    renderStep();

    expect(screen.queryByTestId('source-name-input')).toBeNull();
  });
});

describe('SourceSelectionStep - selecting files', () => {
  it('stays on the source step instead of jumping into Preview', () => {
    // Preview is opt-in now, so picking files must not navigate anywhere on its own.
    const { container } = renderStep();

    selectFiles(container, [file('a.txt'), file('b.txt')]);

    const state = useDataLakeWizardStore.getState();
    expect(state.step).toBe('source');
    expect(state.allFiles).toHaveLength(2);
  });

  it('discloses auto-excluded junk files, which Preview used to announce on mount', () => {
    const { container } = renderStep();

    selectFiles(container, [file('a.txt'), file('.DS_Store')]);

    expect(toastInfo).toHaveBeenCalledWith('Auto-excluded 1 junk file');
  });

  it('stays quiet when nothing was auto-excluded', () => {
    const { container } = renderStep();

    selectFiles(container, [file('a.txt')]);

    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('summarizes what landed, so skipping Preview still shows the count', () => {
    const { container } = renderStep();

    selectFiles(container, [file('a.txt'), file('b.txt'), file('.DS_Store')]);

    expect(screen.getByTestId('source-file-summary')).toHaveTextContent('2 files ready');
    // Neutral wording: returning from Preview folds the user's own exclusions into this count.
    expect(screen.getByTestId('source-file-summary')).toHaveTextContent('1 excluded');
  });
});

describe('SourceSelectionStep - optional step opt-ins', () => {
  const toggle = (testId: string) => screen.getByTestId(testId).querySelector('input') as HTMLInputElement;

  it('hides the toggles until there are files to act on', () => {
    renderStep();

    expect(screen.queryByTestId('source-toggle-preview')).toBeNull();
    expect(screen.queryByTestId('source-toggle-taxonomy')).toBeNull();
  });

  it('defaults both optional steps off, keeping the minimal path at three steps', () => {
    const { container } = renderStep();
    selectFiles(container, [file('a.txt')]);

    expect(toggle('source-toggle-preview').checked).toBe(false);
    expect(toggle('source-toggle-taxonomy').checked).toBe(false);
  });

  it('records each opt-in on the store, which drives the wizard step order', () => {
    const { container } = renderStep();
    selectFiles(container, [file('a.txt')]);

    fireEvent.click(toggle('source-toggle-preview'));
    expect(useDataLakeWizardStore.getState().optionalSteps).toEqual({ preview: true, taxonomy: false });

    fireEvent.click(toggle('source-toggle-taxonomy'));
    expect(useDataLakeWizardStore.getState().optionalSteps).toEqual({ preview: true, taxonomy: true });
  });

  it('offers no taxonomy opt-in in append mode, where the lake tags already exist', () => {
    useDataLakeWizardStore.setState({
      targetLake: {
        id: 'lake-1',
        name: 'Niche',
        slug: 'niche',
        fileTagPrefix: 'niche:',
        organizationId: 'org-1',
        canManage: true,
      },
    });
    const { container } = renderStep();
    selectFiles(container, [file('a.txt')]);

    expect(screen.getByTestId('source-toggle-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('source-toggle-taxonomy')).toBeNull();
  });
  describe('the Drive connect control is gated the way its sibling is', () => {
    // Connecting Drive is an org-lake, owner/manager capability server-side: a personal lake has no
    // org to hold a connection, and the status route 404s for a non-manager. This render site was
    // ungated, so opening Add files on a personal lake fired a pointless GET /drive-connection. A
    // personal lake now gets a static disabled control with the reason, which fetches nothing.
    const appendTo = (over: Partial<WizardTargetLake> = {}) =>
      useDataLakeWizardStore.setState({
        targetLake: {
          id: 'lake-1',
          name: 'Niche',
          slug: 'niche',
          fileTagPrefix: 'niche:',
          organizationId: 'org-1',
          canManage: true,
          ...over,
        },
      });

    it('offers Drive disabled on a personal lake, without mounting the live connect control', () => {
      appendTo({ organizationId: null });
      renderStep();

      expect(screen.getByTestId('drive-connect-personal-lake-btn')).toBeDisabled();
      expect(screen.queryByTestId('lake-source-connect-actions')).toBeNull();
      // And not the create-mode fallback either - there IS a target lake, it just cannot connect.
      expect(screen.queryByTestId('drive-pending-connect-action')).toBeNull();
    });

    it('renders NO connect control for a non-manager on an org lake', () => {
      // The non-manager half of the same gate. Without it the two render sites disagree, which let
      // this one drift in the first place.
      appendTo({ canManage: false });
      renderStep();

      expect(screen.queryByTestId('lake-source-connect-actions')).toBeNull();
      expect(screen.queryByTestId('drive-connect-personal-lake-btn')).toBeNull();
    });

    it('renders the connect control for a manager on an org lake', () => {
      appendTo({});
      renderStep();

      expect(screen.getByTestId('lake-source-connect-actions')).toBeInTheDocument();
    });

    it('still parks the selection under the Drive card, where there is no lake to gate on yet', () => {
      // Create mode now reaches Drive through its own card rather than offering it beside Upload,
      // so the deferral this asserts is exercised from that screen.
      pickSource('googleDrive');
      renderStep();

      expect(screen.getByTestId('drive-pending-connect-action')).toBeInTheDocument();
      expect(screen.queryByTestId('lake-source-connect-actions')).toBeNull();
    });
  });
});
