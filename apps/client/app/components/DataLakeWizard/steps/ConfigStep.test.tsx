import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import ConfigStep from './ConfigStep';

/**
 * The duplicate-name hint has to match the scope the create will actually land in:
 * the server disambiguates slugs per-org, so a same-named lake in another org is not
 * a collision and must not warn.
 */

const { lakes, selectedAccount } = vi.hoisted(() => ({
  lakes: { current: [] as { id: string; name: string; organizationId?: string }[] },
  selectedAccount: { current: { id: 'me', personal: true } as { id: string; personal: boolean } | null },
}));

// Stub only the hooks; the pure slug helpers live in the unmocked dataLakeSlug
// module so this test exercises the real slugify/validation logic.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useComputeHashes: () => ({ mutate: vi.fn(), isPending: false }),
  useCheckDuplicates: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useGetDataLakes: () => ({ data: lakes.current }),
}));
vi.mock('@client/app/components/Credits/AccountSelector', () => ({
  useSelectedAccount: (selector: (s: { selectedAccount: unknown }) => unknown) =>
    selector({ selectedAccount: selectedAccount.current }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const setName = (name: string) => {
  useDataLakeWizardStore.setState({
    step: 'config',
    targetLake: null,
    allFiles: [],
    config: {
      name,
      description: '',
      tagPrefix: 'test:',
      requiredUserTag: '',
      requiredEntitlement: '',
      conflictResolution: 'skip',
    },
  });
};

const WARNING = 'config-name-duplicate-warning';

describe('ConfigStep - duplicate lake name warning', () => {
  beforeEach(() => {
    lakes.current = [];
    selectedAccount.current = { id: 'me', personal: true };
  });

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('warns when a personal lake already uses the name, ignoring case and padding', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche' }];
    setName('  niche ');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.getByTestId(WARNING)).toHaveTextContent('Niche');
  });

  it('stays silent when no name matches', () => {
    lakes.current = [{ id: 'lake-1', name: 'Other Lake' }];
    setName('Niche');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('stays silent for a same-named lake outside the active scope', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche', organizationId: 'org-a' }];
    setName('Niche');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.queryByTestId(WARNING)).toBeNull();
  });

  it('warns on a same-named lake in the active org when an org is selected', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche', organizationId: 'org-a' }];
    selectedAccount.current = { id: 'org-a', personal: false };
    setName('Niche');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.getByTestId(WARNING)).toBeInTheDocument();
  });

  it('stays silent in append mode, where the name is locked to the target lake', () => {
    lakes.current = [{ id: 'lake-1', name: 'Niche' }];
    setName('Niche');
    useDataLakeWizardStore.setState({
      targetLake: { id: 'lake-1', name: 'Niche', slug: 'niche', fileTagPrefix: 'niche:' },
    });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.queryByTestId(WARNING)).toBeNull();
  });
});

const SLUG_ERROR = 'config-name-slug-error';

describe('ConfigStep - slug validation hint', () => {
  beforeEach(() => {
    lakes.current = [];
    selectedAccount.current = { id: 'me', personal: true };
  });

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('flags a name that slugifies too short (below the server 2-char minimum)', () => {
    setName('!!');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.getByTestId(SLUG_ERROR)).toBeInTheDocument();
  });

  it('stays silent for a name that yields a valid slug', () => {
    setName('Legal Contracts');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.queryByTestId(SLUG_ERROR)).toBeNull();
  });

  it('stays silent for an empty name (no nagging before the user types)', () => {
    setName('');

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.queryByTestId(SLUG_ERROR)).toBeNull();
  });

  it('shows the target lake real slug in append mode, not what the name slugifies to', () => {
    // The lake's stored slug can be disambiguated (e.g. "niche-2") and differ from
    // slugify(name); the preview must show the real appended slug, and never flag it.
    setName('Niche');
    useDataLakeWizardStore.setState({
      targetLake: { id: 'lake-1', name: 'Niche', slug: 'niche-2', fileTagPrefix: 'niche:' },
    });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(screen.getByText('niche-2')).toBeInTheDocument();
    expect(screen.queryByTestId(SLUG_ERROR)).toBeNull();
  });
});

/**
 * Reconciliation of #829 (taxonomy applies tags -> prefix is meaningful there) with #826
 * (Tag Prefix de-duped to a single home). The single editable home is now the taxonomy
 * step, so Config shows the prefix read-only - except the empty-prefix dead-end, where a
 * skippable/empty taxonomy would otherwise strand the user at Config's tagPrefix>=2 gate.
 */
describe('ConfigStep - Tag Prefix single home + empty-prefix fallback', () => {
  const seedConfig = (over: { tagPrefix: string; targetLake?: unknown }) =>
    useDataLakeWizardStore.setState({
      step: 'config',
      targetLake: (over.targetLake ?? null) as never,
      allFiles: [],
      config: {
        name: 'My Lake',
        description: '',
        tagPrefix: over.tagPrefix,
        requiredUserTag: '',
        requiredEntitlement: '',
        conflictResolution: 'skip',
      },
    });

  const prefixInput = () => screen.getByTestId('config-tag-prefix-input').querySelector('input') as HTMLInputElement;

  beforeEach(() => {
    lakes.current = [];
    selectedAccount.current = { id: 'me', personal: true };
  });

  afterEach(() => {
    useDataLakeWizardStore.getState().resetWizard();
  });

  it('shows the prefix read-only in create mode when the taxonomy step already set one', () => {
    seedConfig({ tagPrefix: 'acme:' });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(prefixInput().disabled).toBe(true);
    expect(prefixInput().value).toBe('acme:');
    expect(screen.getByText(/Set on the AI Taxonomy step/i)).toBeInTheDocument();
  });

  it('falls back to an editable prefix when create mode arrives with an empty prefix', () => {
    // Taxonomy skipped or inference returned no prefix: without this the user hits the
    // tagPrefix>=2 gate on Start Upload with no field to fix it.
    seedConfig({ tagPrefix: '' });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(prefixInput().disabled).toBe(false);
    expect(screen.getByText(/No taxonomy prefix was set/i)).toBeInTheDocument();
  });

  it('locks the prefix to the target lake in append mode (taxonomy step is skipped there)', () => {
    seedConfig({
      tagPrefix: 'niche:',
      targetLake: { id: 'l1', name: 'Niche', slug: 'niche', fileTagPrefix: 'niche:' },
    });

    render(
      <TestWrapper>
        <ConfigStep />
      </TestWrapper>
    );

    expect(prefixInput().disabled).toBe(true);
    expect(prefixInput().value).toBe('niche:');
    expect(screen.getByText(/Inherited from the existing data lake/i)).toBeInTheDocument();
  });
});
