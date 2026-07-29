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

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const seedConfig = (over: { tagPrefix?: string; name?: string; taxonomyStep?: boolean; targetLake?: unknown }) =>
  useDataLakeWizardStore.setState({
    step: 'config',
    targetLake: (over.targetLake ?? null) as never,
    allFiles: [],
    optionalSteps: { preview: false, taxonomy: over.taxonomyStep ?? false },
    config: {
      name: over.name ?? 'My Lake',
      description: '',
      tagPrefix: over.tagPrefix ?? 'test:',
      requiredUserTag: '',
      requiredEntitlement: '',
      conflictResolution: 'skip',
    },
  });

const renderStep = () =>
  render(
    <TestWrapper>
      <ConfigStep />
    </TestWrapper>
  );

afterEach(() => {
  useDataLakeWizardStore.getState().resetWizard();
});

/**
 * The Tag Prefix has exactly one editable home, and which step that is depends on whether the
 * user opted into the taxonomy step (#824) - that step embeds the prefix in every tag it
 * renders (#829), so it owns the field whenever it is in the flow.
 */
describe('ConfigStep - Tag Prefix single editable home', () => {
  const prefixInput = () => screen.getByTestId('config-tag-prefix-input').querySelector('input') as HTMLInputElement;

  it('shows the prefix read-only when the taxonomy step is in the flow and owns it', () => {
    seedConfig({ tagPrefix: 'acme:', taxonomyStep: true });

    renderStep();

    expect(prefixInput().disabled).toBe(true);
    expect(prefixInput().value).toBe('acme:');
    expect(screen.getByText(/Set on the AI Taxonomy step/i)).toBeInTheDocument();
  });

  it('is editable here when the taxonomy step was skipped, so no step is left owning it', () => {
    // Without this the user meets Start Upload's tagPrefix>=2 gate with no field to fix it.
    seedConfig({ tagPrefix: 'my-lake:', taxonomyStep: false });

    renderStep();

    expect(prefixInput().disabled).toBe(false);
    expect(screen.getByText(/Derived from the name/i)).toBeInTheDocument();
  });

  it('flags a reserved prefix even though the field is read-only here', () => {
    // The prefix arrives from the taxonomy step, so the field is disabled - but the server
    // rejects the datalake: namespace outright and Start Upload is gated on it. Without a
    // message here the button is disabled with no visible reason. taxonomyStep is what makes
    // the field read-only now, so the case has to be seeded with the step in the flow.
    seedConfig({ tagPrefix: 'datalake:', taxonomyStep: true });

    renderStep();

    expect(screen.getByTestId('datalake-config-tagprefix-help').textContent).toMatch(/reserved/i);
    expect(screen.queryByText(/Set on the AI Taxonomy step/i)).not.toBeInTheDocument();
  });

  it('flags a reserved prefix while editable here too, where the derive could produce one', () => {
    // A lake named "Datalake" derives exactly this prefix, so the editable path needs the
    // same message - see the guard in deriveTagPrefixFromName.
    seedConfig({ tagPrefix: 'datalake:', taxonomyStep: false });

    renderStep();

    expect(screen.getByTestId('datalake-config-tagprefix-help').textContent).toMatch(/reserved/i);
    expect(prefixInput().disabled).toBe(false);
  });

  it('locks the prefix to the target lake in append mode (taxonomy is never offered there)', () => {
    seedConfig({
      tagPrefix: 'niche:',
      taxonomyStep: false,
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
