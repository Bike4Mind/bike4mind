import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import SourceSelectionStep from './SourceSelectionStep';

const { lakes, selectedAccount, toastInfo } = vi.hoisted(() => ({
  lakes: { current: [] as { id: string; name: string; organizationId?: string }[] },
  selectedAccount: { current: { id: 'me', personal: true } as { id: string; personal: boolean } | null },
  toastInfo: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: lakes.current }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: selectedAccount.current }),
}));
vi.mock('sonner', () => ({ toast: { info: toastInfo } }));

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
  selectedAccount.current = { id: 'me', personal: true };
  toastInfo.mockClear();
});

afterEach(() => {
  useDataLakeWizardStore.getState().resetWizard();
});

/**
 * Identity moved here from Config (#824): the user names the lake before committing files,
 * so the duplicate-name and slug hints have to move with the field.
 */
describe('SourceSelectionStep - lake name', () => {
  const WARNING = 'source-name-duplicate-warning';
  const SLUG_ERROR = 'source-name-slug-error';

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

    expect(screen.getByTestId(SLUG_ERROR)).toBeInTheDocument();
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

  it('offers no name field in append mode - the target lake owns its identity', () => {
    useDataLakeWizardStore.setState({
      targetLake: { id: 'lake-1', name: 'Niche', slug: 'niche', fileTagPrefix: 'niche:' },
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
      targetLake: { id: 'lake-1', name: 'Niche', slug: 'niche', fileTagPrefix: 'niche:' },
    });
    const { container } = renderStep();
    selectFiles(container, [file('a.txt')]);

    expect(screen.getByTestId('source-toggle-preview')).toBeInTheDocument();
    expect(screen.queryByTestId('source-toggle-taxonomy')).toBeNull();
  });
});
