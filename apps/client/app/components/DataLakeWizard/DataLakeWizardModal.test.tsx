import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useUser } from '@client/app/contexts/UserContext';
import type { IUserDocument } from '@bike4mind/common';
import DataLakeWizardModal from './DataLakeWizardModal';

/**
 * Regression coverage: clicking "Start Upload" while offline must short-circuit
 * before the mutation is triggered, and reflect the same uploadProgress.errorMessage
 * that useBatchUpload's onError would write, so the two entry points (this pre-flight
 * check vs. a retry that calls mutate() directly) stay in sync.
 */

const { toastMock, batchUploadMutate, driveCommitMutate } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  batchUploadMutate: vi.fn(),
  driveCommitMutate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));
// Stub only the hooks; isValidDataLakeSlug comes from the unmocked dataLakeSlug
// module so the config gate is checked against the real validation logic.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useBatchUpload: () => ({ mutate: batchUploadMutate, isPending: false }),
  useCreateLakeFromDrive: () => ({ mutate: driveCommitMutate, isPending: false }),
  useComputeHashes: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckDuplicates: () => ({ mutate: vi.fn(), isPending: false }),
  useBatchProgressListener: () => undefined,
  OFFLINE_MESSAGE: 'No internet connection. Check your network and try again.',
}));
// ConfigStep reads the lake list for its duplicate-name hint; stub it so this test
// needs no QueryClientProvider.
const prefixClash = vi.hoisted(() => ({ current: undefined as { name: string; fileTagPrefix: string } | undefined }));
const prefixPreview = vi.hoisted(() => ({
  current: undefined as { slug: string; tagPrefix: string | null } | undefined,
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: [] }),
  useDuplicatePrefixLake: () => prefixClash.current,
  activeOrgId: () => undefined,
  useDataLakeSlugPreview: () => ({ data: prefixPreview.current }),
  usePromoteDataLake: () => ({ mutate: vi.fn(), isPending: false }),
}));
// SourceSelectionStep renders LakeSourceConnectActions, which pulls in React Query (useConfig /
// lake-connection hooks); stub it so this wizard test needs no QueryClientProvider.
vi.mock('@client/app/components/DataLakeWizard/steps/LakeSourceConnectActions', () => ({
  default: () => null,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/DrivePendingConnectAction', () => ({
  default: () => null,
}));
// The source cards and the GitHub panel read the account scope through react-query; this file is
// about the wizard's step order and commit gating, and every seed below answers the source question
// directly, so neither screen is what these tests render.
vi.mock('@client/app/components/DataLakeWizard/steps/CreateSourceCards', () => ({
  default: () => <div data-testid="create-source-cards" />,
}));
vi.mock('@client/app/components/DataLakeWizard/steps/GitHubCreatePanel', () => ({
  default: () => <div data-testid="github-create-panel" />,
}));
vi.mock('@client/app/components/datalake/createLakeSources', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/app/components/datalake/createLakeSources')>()),
  useCreateLakeScope: () => ({ organizationId: undefined, isOrgOwnerOrManager: false }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: () => true }),
}));
// ConfigStep's embedding-cost estimate reads admin settings via react-query; stub it so this
// wizard test needs no QueryClientProvider. Empty values are enough - the estimate renders
// nothing without a resolved spendEnabled/budget/model, which is not what this file tests.
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: () => undefined,
  useEffectiveEmbeddingModel: () => undefined,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeWizardModal — handleStartUpload offline pre-check', () => {
  beforeEach(() => {
    prefixClash.current = undefined;
    prefixPreview.current = undefined;
    toastMock.error.mockClear();
    batchUploadMutate.mockClear();
    driveCommitMutate.mockClear();
    useDataLakeWizardStore.setState({
      isOpen: true,
      step: 'config',
      targetLake: null,
      createSource: 'upload',
      // Configure is only reachable with a source in hand, and the button gates on that too - so
      // seed one file, or every prefix assertion below would be measuring the missing-source gate.
      allFiles: [{ relativePath: 'a.txt', size: 1, excluded: false }] as never,
      config: {
        name: 'Test Lake',
        description: '',
        tagPrefix: 'test:',
        requiredUserTag: '',
        requiredEntitlement: '',
        conflictResolution: 'skip',
      },
    });
  });

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('shows the offline toast and records the failure without calling the mutation', () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    screen.getByTestId('wizard-start-upload-btn').click();

    expect(batchUploadMutate).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    const [message, opts] = toastMock.error.mock.calls[0] as [string, { id: string; action: { label: string } }];
    expect(message).toBe('No internet connection. Check your network and try again.');
    expect(opts.id).toBe('data-lake-batch-upload-error');
    expect(opts.action.label).toBe('Retry');

    // Same store field useBatchUpload's onError writes, so Configure-step UI (or
    // any future consumer) sees identical state regardless of which check fired.
    expect(useDataLakeWizardStore.getState().uploadProgress.status).toBe('error');
    expect(useDataLakeWizardStore.getState().uploadProgress.errorMessage).toBe(message);

    onLineSpy.mockRestore();
  });

  it.each([
    ['complete', false],
    ['error', true],
  ] as const)('on the upload step, a %s upload shows the footer: %s', (status, footerShown) => {
    useDataLakeWizardStore.setState({ step: 'upload' });
    useDataLakeWizardStore.getState().updateUploadProgress({ status: 'uploading' });
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-footer')).toBeInTheDocument();

    act(() => useDataLakeWizardStore.getState().updateUploadProgress({ status }));
    expect(screen.queryByTestId('wizard-footer') !== null).toBe(footerShown);
  });

  it('calls the mutation directly when online', () => {
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    screen.getByTestId('wizard-start-upload-btn').click();

    expect(batchUploadMutate).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('disables Start Upload when the name slugifies too short, and clicking it is a no-op', () => {
    // "!!" slugifies to an empty string - shorter than the server's slug.min(2), which
    // would otherwise be rejected only at the final upload step.
    useDataLakeWizardStore.setState(state => ({ config: { ...state.config, name: '!!' } }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    btn.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  // The overlap error renders on the prefix field, but THIS is the guard that stops a bad lake
  // being created: two lakes sharing a fileTagPrefix share their prefix-tagged files, so
  // permanently deleting one would take files only the other holds. Next is deliberately not
  // gated (same as the pre-existing reserved-prefix check), so Start Upload is the only block.
  it('disables Start Upload when the tag prefix overlaps another lake, and clicking it is a no-op', () => {
    prefixClash.current = { name: 'Docs Lake', fileTagPrefix: 'docs:' };

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    btn.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  // Mirrors the server's blank-segment schema refine: without this gate the user runs
  // hashing/dedup and only then gets a 422 at the final step.
  it('disables Start Upload when the tag prefix has a blank segment, and clicking it is a no-op', () => {
    useDataLakeWizardStore.setState(state => ({ config: { ...state.config, tagPrefix: 'legal::' } }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    btn.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  // The inverse gate: append mode inherits a stored prefix the user cannot edit on the
  // Config step, so a legacy lake predating the blank-segment rule must keep accepting
  // uploads rather than being locked out with no way to clear the error.
  it('leaves Start Upload enabled in append mode even when the inherited prefix has a blank segment', () => {
    useDataLakeWizardStore.setState(state => ({
      targetLake: { id: 'lake-1', name: 'Legacy Lake', fileTagPrefix: 'legal::' } as never,
      config: { ...state.config, tagPrefix: 'legal::' },
    }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).not.toBeDisabled();
  });

  // The reported failure (#1817): a hand-typed prefix past the server's 30-char cap used to
  // leave Start Upload enabled, so the whole upload died on a 422 at the last step.
  it('disables Start Upload when the tag prefix exceeds the server maximum', () => {
    useDataLakeWizardStore.setState(state => ({
      config: { ...state.config, tagPrefix: 'triage-router-dry-run-test-ken-delete-after:' },
    }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    btn.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  // Same inverse as the blank-segment gate: a stored prefix the Config step cannot edit must
  // not lock its own lake out of uploads.
  it('leaves Start Upload enabled in append mode even when the inherited prefix is too long', () => {
    useDataLakeWizardStore.setState(state => ({
      targetLake: { id: 'lake-1', name: 'Legacy Lake', fileTagPrefix: 'a'.repeat(40) + ':' } as never,
      config: { ...state.config, tagPrefix: 'a'.repeat(40) + ':' },
    }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-start-upload-btn')).not.toBeDisabled();
  });

  // The gate has to size the value the request CARRIES: useBatchUpload closes it with ":",
  // so 30 colon-less characters arrive as 31 and are refused - the same 422 this fix exists
  // to prevent, reached by a hand-typed prefix instead of a derived one.
  it('disables Start Upload when the prefix is at the max but has no trailing colon', () => {
    useDataLakeWizardStore.setState(state => ({
      config: { ...state.config, tagPrefix: 'a'.repeat(30) },
    }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    const btn = screen.getByTestId('wizard-start-upload-btn') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    btn.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  // The same rule in the other direction: a bare "a" is submitted as the perfectly legal
  // "a:", so gating on the field's own length blocked a prefix the server accepts.
  it('leaves Start Upload enabled for a one-character prefix, which submits as a legal two', () => {
    useDataLakeWizardStore.setState(state => ({ config: { ...state.config, tagPrefix: 'a' } }));

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-start-upload-btn')).not.toBeDisabled();
  });

  // The overlap lookup above only sees attachable lakes; an archived or deleted one still holds
  // its prefix, and only the server preview knows.
  it('disables Start Upload when the server reports the typed prefix held by a lake the form cannot see', () => {
    prefixPreview.current = { slug: 'x', tagPrefix: 'docs-1:' };

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-start-upload-btn')).toBeDisabled();
  });

  it('leaves Start Upload enabled while the server preview has no answer', () => {
    prefixPreview.current = { slug: 'x', tagPrefix: null };

    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-start-upload-btn')).not.toBeDisabled();
  });

  it('leaves Start Upload enabled when the prefix is free', () => {
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    expect(screen.getByTestId('wizard-start-upload-btn')).not.toBeDisabled();
  });
});

/**
 * The create flow is name + files -> config -> upload, with Preview spliced in
 * only when the user opts into it on the source step. AI tag suggestion is also opt-in, but
 * no longer a step in this order at all - it runs as a background job after upload.
 */
describe('DataLakeWizardModal - streamlined step order', () => {
  const seedSource = (over: {
    name?: string;
    optionalSteps?: { preview: boolean; taxonomy: boolean };
    targetLake?: unknown;
  }) =>
    useDataLakeWizardStore.setState(state => ({
      isOpen: true,
      step: 'source',
      targetLake: (over.targetLake ?? null) as never,
      // The source question is answered before this step shows anything else (#3817).
      createSource: 'upload',
      allFiles: [{ relativePath: 'a.txt', size: 1, excluded: false }] as never,
      optionalSteps: over.optionalSteps ?? { preview: false, taxonomy: false },
      config: { ...state.config, name: over.name ?? 'Legal Contracts', tagPrefix: '' },
    }));

  const renderModal = () =>
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  // The source question comes first in create mode (#3817), so Next cannot advance past a screen
  // that has not been answered - and the GitHub card never advances through the wizard at all: its
  // Continue creates the lake server-side and leaves the page.
  it('blocks Next until a source card is picked', () => {
    seedSource({});
    useDataLakeWizardStore.setState({ createSource: null });

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled();
  });

  it('keeps Next disabled on the GitHub card, which leaves the wizard instead of advancing', () => {
    seedSource({});
    useDataLakeWizardStore.setState({ createSource: 'github' });

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled();
  });

  it('shows only source, configure and upload when neither optional step is enabled', () => {
    seedSource({});

    renderModal();

    const labels = screen.getAllByTestId('wizard-step-label').map(el => el.textContent);
    expect(labels).toEqual(['Select Source', 'Configure', 'Upload']);
  });

  it('splices Preview into the order when opted in; AI tagging never adds a step', () => {
    // taxonomy: true opts into background AI tagging but never splices a step.
    seedSource({ optionalSteps: { preview: true, taxonomy: true } });

    renderModal();

    const labels = screen.getAllByTestId('wizard-step-label').map(el => el.textContent);
    expect(labels).toEqual(['Select Source', 'Preview', 'Configure', 'Upload']);
  });

  it('blocks leaving source when every file was excluded, with no Preview step to catch it', () => {
    // Auto-exclusion alone can empty a selection (e.g. only junk files picked). Preview used
    // to be the mandatory home of this check; skipping it must not let the user reach Start
    // Upload with nothing to send.
    seedSource({});
    useDataLakeWizardStore.setState({
      allFiles: [{ relativePath: '.DS_Store', size: 1, excluded: true }] as never,
    });

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled();
  });

  it('blocks leaving source until the name yields a server-acceptable slug', () => {
    // Identity is gated here now rather than on Config, so an unusable name is caught
    // before the user commits to anything downstream.
    seedSource({ name: '!!' });

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled();
  });

  it('derives the tag prefix from the name when no taxonomy step will set one', () => {
    // Start Upload gates on tagPrefix >= 2; without this the minimal path stalls there.
    seedSource({ name: 'Legal Contracts' });

    renderModal();
    screen.getByTestId('wizard-next-btn').click();

    const state = useDataLakeWizardStore.getState();
    expect(state.step).toBe('config');
    expect(state.config.tagPrefix).toBe('legal-contracts:');
  });

  it('re-derives the prefix after a rename, so it never references the abandoned name', () => {
    seedSource({ name: 'Legal Contracts' });

    renderModal();
    screen.getByTestId('wizard-next-btn').click();
    useDataLakeWizardStore.setState(state => ({
      step: 'source',
      config: { ...state.config, name: 'Medical Records' },
    }));
    screen.getByTestId('wizard-next-btn').click();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('medical-records:');
  });

  it('leaves a hand-edited prefix alone when the name later changes', () => {
    seedSource({ name: 'Legal Contracts' });

    renderModal();
    screen.getByTestId('wizard-next-btn').click();
    useDataLakeWizardStore.getState().setTagPrefix('custom:');
    useDataLakeWizardStore.setState(state => ({
      step: 'source',
      config: { ...state.config, name: 'Medical Records' },
    }));
    screen.getByTestId('wizard-next-btn').click();

    expect(useDataLakeWizardStore.getState().config.tagPrefix).toBe('custom:');
  });

  it('derives the tag prefix from the name even when AI tagging is opted into', () => {
    // AI tag suggestion runs after upload and never owns the prefix - it's always
    // derived from the name up front, same as the non-AI path.
    seedSource({ optionalSteps: { preview: false, taxonomy: true } });

    renderModal();
    screen.getByTestId('wizard-next-btn').click();

    const state = useDataLakeWizardStore.getState();
    expect(state.step).toBe('config');
    expect(state.config.tagPrefix).toBe('legal-contracts:');
  });
});

/**
 * A lake whose only source is a Google Drive folder (#1916). Every step used to gate on local
 * files, so this path was unreachable: with zero files the source step's Next never enabled, and
 * the commit threw before it created anything.
 */
describe('DataLakeWizardModal - Drive-only create', () => {
  const driveFolder = { driveFolderId: 'FOLDER1', folderName: 'Contracts' };

  const seedDriveOnly = (over: { step?: 'source' | 'config'; name?: string } = {}) =>
    useDataLakeWizardStore.setState(state => ({
      isOpen: true,
      step: over.step ?? 'source',
      targetLake: null,
      createSource: 'googleDrive',
      allFiles: [],
      pendingDriveFolder: driveFolder,
      config: { ...state.config, name: over.name ?? 'Drive Only Lake', tagPrefix: 'drive:' },
    }));

  const renderModal = () =>
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );

  beforeEach(() => {
    prefixClash.current = undefined;
    batchUploadMutate.mockClear();
    driveCommitMutate.mockClear();
    toastMock.error.mockClear();
  });

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
    useUser.setState({ currentUser: null });
  });

  // Nothing uploads on this path (uploadBytes is 0), so a user already over quota must still be
  // able to create-and-sync - the block exists to stop bytes the server would refuse, and this
  // commit sends none.
  it('is not blocked by a storage limit the commit sends no bytes against', () => {
    useUser.setState({ currentUser: { currentStorageSize: 1_000_000, storageLimit: 1 } as IUserDocument });
    seedDriveOnly({ step: 'config' });

    renderModal();
    const commitBtn = screen.getByTestId('wizard-start-upload-btn');

    expect(commitBtn).toBeEnabled();
    commitBtn.click();
    expect(driveCommitMutate).toHaveBeenCalledTimes(1);
  });

  it('advances past the source step on a Drive folder alone, with no files', () => {
    seedDriveOnly();

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).not.toBeDisabled();
  });

  it('still requires a usable name, which the lake is created with either way', () => {
    seedDriveOnly({ name: 'x' }); // slugifies below the server's 2-character minimum

    renderModal();

    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled();
  });

  it('offers a create action rather than an upload, and runs the fileless commit', () => {
    seedDriveOnly({ step: 'config' });

    renderModal();
    const commitBtn = screen.getByTestId('wizard-start-upload-btn');

    expect(commitBtn).toHaveTextContent('Create and sync');
    commitBtn.click();
    expect(driveCommitMutate).toHaveBeenCalledTimes(1);
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  it('runs the upload commit when files are present too, Drive folder or not', () => {
    seedDriveOnly({ step: 'config' });
    useDataLakeWizardStore.setState({
      allFiles: [{ relativePath: 'a.txt', size: 1, excluded: false }] as never,
    });

    renderModal();
    const commitBtn = screen.getByTestId('wizard-start-upload-btn');

    expect(commitBtn).toHaveTextContent('Start Upload');
    commitBtn.click();
    expect(batchUploadMutate).toHaveBeenCalledTimes(1);
    expect(driveCommitMutate).not.toHaveBeenCalled();
  });

  it('treats a picked folder as unsaved progress and discards it on close, creating nothing', () => {
    // The whole point of deferring the connect: abandoning the wizard must leave no lake and no
    // connection row, because neither was ever created.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    seedDriveOnly();

    renderModal();
    screen.getByText('Cancel').click();

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(useDataLakeWizardStore.getState().pendingDriveFolder).toBeNull();
    expect(driveCommitMutate).not.toHaveBeenCalled();
    expect(batchUploadMutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('keeps the picked folder when the discard is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    seedDriveOnly();

    renderModal();
    screen.getByText('Cancel').click();

    expect(useDataLakeWizardStore.getState().pendingDriveFolder).toEqual(driveFolder);
    confirmSpy.mockRestore();
  });
});

describe('DataLakeWizardModal - storage limit', () => {
  const refreshUser = vi.fn(() => Promise.resolve());
  const seed = (step: 'source' | 'config', currentStorageSize: number) => {
    // 1 MB limit, stored in MB like the real user document.
    useUser.setState({ currentUser: { currentStorageSize, storageLimit: 1 } as IUserDocument, refreshUser });
    useDataLakeWizardStore.setState({
      isOpen: true,
      step,
      targetLake: null,
      createSource: 'upload',
      allFiles: [{ relativePath: 'a.txt', size: 10, type: 'text/plain', excluded: false, isDuplicate: false }] as never,
      config: {
        name: 'Test Lake',
        description: '',
        tagPrefix: 'test:',
        requiredUserTag: '',
        requiredEntitlement: '',
        conflictResolution: 'skip',
      },
    });
  };

  afterEach(() => {
    useUser.setState({ currentUser: null });
    useDataLakeWizardStore.getState().resetWizard();
    batchUploadMutate.mockClear();
    refreshUser.mockClear();
  });

  it('warns a user at the limit as soon as a file is selected, before the lake is created', () => {
    seed('source', 1_000_000);
    render(<DataLakeWizardModal />, { wrapper: TestWrapper });
    expect(screen.getByTestId('storage-limit-exceeded-alert')).toBeInTheDocument();
    // Cached usage can be stale after deletes, so a block triggers a fresh read.
    expect(refreshUser).toHaveBeenCalled();
  });

  it('disables Start Upload for a user at the limit, so no create request is sent', () => {
    seed('config', 1_000_000);
    render(<DataLakeWizardModal />, { wrapper: TestWrapper });
    const start = screen.getByTestId('wizard-start-upload-btn');
    expect(start).toBeDisabled();
    start.click();
    expect(batchUploadMutate).not.toHaveBeenCalled();
  });

  it('changes nothing for a user under the limit', () => {
    seed('config', 0);
    render(<DataLakeWizardModal />, { wrapper: TestWrapper });
    expect(screen.queryByTestId('storage-limit-exceeded-alert')).toBeNull();
    expect(screen.queryByTestId('storage-limit-near-alert')).toBeNull();
    expect(screen.getByTestId('wizard-start-upload-btn')).toBeEnabled();
    expect(refreshUser).not.toHaveBeenCalled();
  });
});
