import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import DataLakeWizardModal from './DataLakeWizardModal';

/**
 * Regression coverage: clicking "Start Upload" while offline must short-circuit
 * before the mutation is triggered, and reflect the same uploadProgress.errorMessage
 * that useBatchUpload's onError would write, so the two entry points (this pre-flight
 * check vs. a retry that calls mutate() directly) stay in sync.
 */

const { toastMock, batchUploadMutate } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  batchUploadMutate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: toastMock }));
// Stub only the hooks; isValidDataLakeSlug comes from the unmocked dataLakeSlug
// module so the config gate is checked against the real validation logic.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useBatchUpload: () => ({ mutate: batchUploadMutate, isPending: false }),
  useComputeHashes: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckDuplicates: () => ({ mutate: vi.fn(), isPending: false }),
  OFFLINE_MESSAGE: 'No internet connection. Check your network and try again.',
}));
// ConfigStep reads the lake list for its duplicate-name hint; stub it so this test
// needs no QueryClientProvider.
const prefixClash = vi.hoisted(() => ({ current: undefined as { name: string; fileTagPrefix: string } | undefined }));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: [] }),
  useDuplicatePrefixLake: () => prefixClash.current,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DataLakeWizardModal — handleStartUpload offline pre-check', () => {
  beforeEach(() => {
    prefixClash.current = undefined;
    toastMock.error.mockClear();
    batchUploadMutate.mockClear();
    useDataLakeWizardStore.setState({
      isOpen: true,
      step: 'config',
      targetLake: null,
      allFiles: [],
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
