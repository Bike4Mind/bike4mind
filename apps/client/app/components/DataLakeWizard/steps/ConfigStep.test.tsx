import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import ConfigStep from './ConfigStep';

// Stub only the hooks; the pure slug helpers live in the unmocked dataLakeSlug
// module so this test exercises the real slugify logic.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useComputeHashes: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckDuplicates: () => ({ mutate: vi.fn(), isPending: false }),
}));
// ConfigStep reads the collision hook; the name/duplicate-name hint moved to the source step,
// so this is the only lake-hook it still needs.
const prefixClash = vi.hoisted(() => ({ current: undefined as { name: string; fileTagPrefix: string } | undefined }));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useDuplicatePrefixLake: () => prefixClash.current,
}));

// The embedding-cost estimate reads admin settings via react-query; stub the values instead of
// standing up a QueryClientProvider. Steady state: spend governance on with a real budget and a
// priced model, so the estimate/budget suite below controls exactly the values that matter.
const settingsValues = vi.hoisted(() => ({
  current: {
    dataLakeEmbeddingSpendEnabled: 'true' as string | boolean | undefined,
    dataLakeEmbeddingBudgetPerRunUsd: '5' as string | number | undefined,
    defaultEmbeddingModel: 'text-embedding-3-small' as string | undefined,
  },
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: keyof typeof settingsValues.current) => settingsValues.current[key],
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const seedConfig = (over: {
  tagPrefix?: string;
  name?: string;
  targetLake?: unknown;
  allFiles?: unknown[];
  conflictResolution?: 'skip' | 'update' | 'duplicate';
}) =>
  useDataLakeWizardStore.setState({
    step: 'config',
    targetLake: (over.targetLake ?? null) as never,
    allFiles: (over.allFiles ?? []) as never,
    optionalSteps: { preview: false, taxonomy: false },
    config: {
      name: over.name ?? 'My Lake',
      description: '',
      tagPrefix: over.tagPrefix ?? 'test:',
      requiredUserTag: '',
      requiredEntitlement: '',
      conflictResolution: over.conflictResolution ?? 'skip',
    },
  });

const mockWizardFile = (name: string, size: number, overrides: Record<string, unknown> = {}) => ({
  file: { name } as File,
  relativePath: name,
  size,
  type: 'text/plain',
  excluded: false,
  isDuplicate: false,
  ...overrides,
});

const renderStep = () =>
  render(
    <TestWrapper>
      <ConfigStep />
    </TestWrapper>
  );

afterEach(() => {
  useDataLakeWizardStore.getState().resetWizard();
  settingsValues.current = {
    dataLakeEmbeddingSpendEnabled: 'true',
    dataLakeEmbeddingBudgetPerRunUsd: '5',
    defaultEmbeddingModel: 'text-embedding-3-small',
  };
});

/**
 * The Tag Prefix's only editable home is here (the taxonomy step, its former competing
 * owner, was removed - AI tag suggestion now runs post-upload and never touches the prefix).
 * Append mode is the only case that still locks it, to the target lake's own prefix.
 */
describe('ConfigStep - Tag Prefix single editable home', () => {
  const prefixInput = () => screen.getByTestId('config-tag-prefix-input').querySelector('input') as HTMLInputElement;

  beforeEach(() => {
    prefixClash.current = undefined;
  });

  it('explains an overlapping prefix, which the server refuses at create', () => {
    // Two lakes sharing a prefix share their prefix-tagged files, so permanently deleting either
    // takes the other's. Start Upload is gated on this, so the field has to say why.
    prefixClash.current = { name: 'Acme Archive', fileTagPrefix: 'acme:' };
    seedConfig({ tagPrefix: 'acme:' });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    const help = screen.getByTestId('datalake-config-tagprefix-help').textContent ?? '';
    expect(help).toMatch(/overlaps/i);
    expect(help).toContain('Acme Archive');
  });

  it('says nothing about overlap when the prefix is free', () => {
    seedConfig({ tagPrefix: 'acme:' });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.getByTestId('datalake-config-tagprefix-help').textContent).not.toMatch(/overlaps/i);
  });

  it('is editable in create mode', () => {
    // Without this the user meets Start Upload's tagPrefix>=2 gate with no field to fix it.
    seedConfig({ tagPrefix: 'my-lake:' });

    renderStep();

    expect(prefixInput().disabled).toBe(false);
    expect(screen.getByText(/Derived from the name/i)).toBeInTheDocument();
  });

  it('flags a reserved prefix, where the derive could produce one', () => {
    // A lake named "Datalake" derives exactly this prefix, so the editable path needs the
    // same message - see the guard in deriveTagPrefixFromName.
    seedConfig({ tagPrefix: 'datalake:' });

    renderStep();

    expect(screen.getByTestId('datalake-config-tagprefix-help').textContent).toMatch(/reserved/i);
    expect(prefixInput().disabled).toBe(false);
  });

  // #1817: this is the message that was missing entirely - the create just 422'd with the
  // form showing nothing, so the limit has to be named here, next to the field.
  it('names the 30-character limit, and the actual length, for an over-long prefix', () => {
    seedConfig({ tagPrefix: 'triage-router-dry-run-test-ken-delete-after:' });

    renderStep();

    const help = screen.getByTestId('datalake-config-tagprefix-help').textContent ?? '';
    expect(help).toContain('30 characters or fewer');
    expect(help).toContain('44');
    expect(prefixInput().disabled).toBe(false);
  });

  it('flags a prefix that only busts the limit once its trailing ":" is added', () => {
    seedConfig({ tagPrefix: 'a'.repeat(30) });

    renderStep();

    expect(screen.getByTestId('datalake-config-tagprefix-help').textContent).toMatch(/30 characters or fewer/);
  });

  it('locks the prefix to the target lake in append mode (taxonomy is never offered there)', () => {
    seedConfig({
      tagPrefix: 'niche:',
      targetLake: { id: 'l1', name: 'Niche', slug: 'niche', fileTagPrefix: 'niche:' },
    });

    renderStep();

    expect(prefixInput().disabled).toBe(true);
    expect(prefixInput().value).toBe('niche:');
    expect(screen.getByText(/Inherited from the existing data lake/i)).toBeInTheDocument();
  });
});

/**
 * The name is set on the source step now, so Config echoes it read-only: this is the last
 * screen before upload and must still say what is about to be created.
 */
describe('ConfigStep - identity summary', () => {
  it('echoes the name and its derived slug in create mode', () => {
    seedConfig({ name: 'Legal Contracts' });

    renderStep();

    expect(screen.getByTestId('config-summary-name')).toHaveTextContent('Legal Contracts');
    expect(screen.getByText('legal-contracts')).toBeInTheDocument();
  });

  it('shows the target lake real slug in append mode, not what the name slugifies to', () => {
    // The lake's stored slug can be disambiguated (e.g. "niche-2") and differ from
    // slugify(name); the summary must show the real appended slug.
    seedConfig({
      name: 'Niche',
      targetLake: { id: 'lake-1', name: 'Niche', slug: 'niche-2', fileTagPrefix: 'niche:' },
    });

    renderStep();

    expect(screen.getByText('niche-2')).toBeInTheDocument();
  });

  it('offers no editable name field - the source step is its single home', () => {
    seedConfig({ name: 'Legal Contracts' });

    renderStep();

    expect(screen.queryByTestId('config-name-input')).toBeNull();
  });
});

describe('ConfigStep - embedding cost estimate banner', () => {
  it('shows the estimate line for a plausible, in-budget upload', () => {
    seedConfig({ allFiles: [mockWizardFile('a.txt', 50_000)] });

    renderStep();

    expect(screen.getByTestId('datalake-estimate-line')).toBeInTheDocument();
    expect(screen.queryByTestId('datalake-estimate-over-budget-alert')).not.toBeInTheDocument();
  });

  it('shows the over-budget warning without disabling anything (advisory only)', () => {
    settingsValues.current.dataLakeEmbeddingBudgetPerRunUsd = '0.0000001';
    seedConfig({ allFiles: [mockWizardFile('big.txt', 5_000_000)] });

    renderStep();

    expect(screen.getByTestId('datalake-estimate-over-budget-alert')).toHaveTextContent(/approximate/i);
    expect(screen.getByTestId('datalake-estimate-over-budget-alert')).toHaveTextContent(/rounds up/i);
  });

  it('warns that indexing is paused (not silent) when spend governance is off', () => {
    settingsValues.current.dataLakeEmbeddingSpendEnabled = 'false';
    seedConfig({ allFiles: [mockWizardFile('a.txt', 50_000)] });

    renderStep();

    expect(screen.queryByTestId('datalake-estimate-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-estimate-over-budget-alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('datalake-estimate-spend-disabled-alert')).toHaveTextContent(/indexing is paused/i);
  });

  it('renders nothing for a self-host zero-price embedding model', () => {
    settingsValues.current.defaultEmbeddingModel = 'nomic-embed-text';
    seedConfig({ allFiles: [mockWizardFile('a.txt', 5_000_000)] });

    renderStep();

    expect(screen.queryByTestId('datalake-estimate-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-estimate-over-budget-alert')).not.toBeInTheDocument();
  });

  it('excludes a skipped duplicate from the estimate (it uploads nothing)', () => {
    settingsValues.current.dataLakeEmbeddingBudgetPerRunUsd = '0.0000001';
    seedConfig({
      allFiles: [mockWizardFile('dup.txt', 5_000_000, { isDuplicate: true })],
      conflictResolution: 'skip',
    });

    renderStep();

    // Nothing left to embed once the only file is a skipped duplicate - no estimate at all.
    expect(screen.queryByTestId('datalake-estimate-line')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-estimate-over-budget-alert')).not.toBeInTheDocument();
  });

  it('never touches the Start Upload button - advisory only', () => {
    settingsValues.current.dataLakeEmbeddingBudgetPerRunUsd = '0.0000001';
    seedConfig({ allFiles: [mockWizardFile('big.txt', 5_000_000)] });

    renderStep();

    expect(screen.getByTestId('datalake-estimate-over-budget-alert')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-start-upload-btn')).toBeNull();
  });
});
