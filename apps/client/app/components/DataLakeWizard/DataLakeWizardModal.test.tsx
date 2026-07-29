import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore, type TaxonomyTag } from '@client/app/stores/useDataLakeWizardStore';
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
  useInferTaxonomy: () => ({ mutate: vi.fn(), isPending: false }),
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
});

/**
 * Regression coverage: the taxonomy step gated Next on a successful inference run, so an
 * empty result - or a failed one, which never set the flag at all - stranded the user in
 * the wizard with a dead Next button. Inference is optional by design (the endpoint itself
 * returns an empty taxonomy when no API key is configured), so it must never block.
 */
describe('DataLakeWizardModal - taxonomy step is optional', () => {
  const renderAtTaxonomyStep = (tags: TaxonomyTag[], analyzing = false) => {
    useDataLakeWizardStore.setState({
      isOpen: true,
      step: 'taxonomy',
      targetLake: null,
      taxonomy: {
        prefix: 'test:',
        suggestedName: '',
        tags,
        fileAssignments: [],
        attempted: !analyzing,
        analyzing,
      },
    });
    render(
      <TestWrapper>
        <DataLakeWizardModal />
      </TestWrapper>
    );
    return screen.getByTestId('wizard-next-btn') as HTMLButtonElement;
  };

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('lets the user continue past an empty result, labelling the button Skip', () => {
    const next = renderAtTaxonomyStep([]);

    expect(next.disabled).toBe(false);
    expect(next.textContent).toContain('Skip');
    expect(screen.getByTestId('taxonomy-empty-state')).toBeTruthy();
  });

  it('holds the user on the step while inference is still in flight', () => {
    // Inference's result overwrites config.name and config.tagPrefix, so advancing mid-flight
    // would clobber what the user then types on Config. "Skip" would also be a lie here: tags
    // landing after the click are still applied at upload.
    const next = renderAtTaxonomyStep([], true);

    expect(next.disabled).toBe(true);
    expect(next.textContent).toContain('Next');
  });

  it('labels the button Next once there are tags to apply', () => {
    const next = renderAtTaxonomyStep([
      {
        suffix: 'type:contract',
        originalName: 'test:type:contract',
        strength: 0.9,
        source: 'ai',
        matchingFolders: ['legal'],
        deleted: false,
      },
    ]);

    expect(next.disabled).toBe(false);
    expect(next.textContent).toContain('Next');
  });
});
