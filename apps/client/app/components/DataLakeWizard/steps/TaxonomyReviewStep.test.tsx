import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { useDataLakeWizardStore, type TaxonomyTag } from '@client/app/stores/useDataLakeWizardStore';
import TaxonomyReviewStep from './TaxonomyReviewStep';

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useDuplicatePrefixLake: () => undefined,
}));

/**
 * The prefix is a single shared value (taxonomy.prefix); each card renders `prefix + suffix`.
 * So editing a tag can only change its suffix (never inject a second namespace), and editing
 * the one prefix input re-namespaces every card at once. These pin that contract plus the two
 * guards: an empty suffix can't be saved, and an empty/short prefix shows the required error.
 */

// Inference auto-triggers on mount unless already attempted; stub it so the step is inert.
vi.mock('@client/app/hooks/data/dataLakeWizard', () => ({
  useInferTaxonomy: () => ({ mutate: vi.fn(), isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const mkTag = (over: Partial<TaxonomyTag> & { suffix: string }): TaxonomyTag => ({
  originalName: `acme:${over.suffix}`,
  strength: 0.95,
  source: 'ai',
  matchingFolders: ['legal'],
  deleted: false,
  ...over,
});

const seed = (prefix: string, tags: TaxonomyTag[]) =>
  useDataLakeWizardStore.setState({
    isOpen: true,
    step: 'taxonomy',
    targetLake: null,
    taxonomy: { prefix, suggestedName: 'Acme', tags, fileAssignments: [], attempted: true, analyzing: false },
  });

const renderStep = () =>
  render(
    <TestWrapper>
      <TaxonomyReviewStep />
    </TestWrapper>
  );

const suffixInput = () => screen.getByTestId('taxonomy-tag-suffix-input').querySelector('input') as HTMLInputElement;
const prefixInput = () => screen.getByTestId('taxonomy-tag-prefix-input').querySelector('input') as HTMLInputElement;

describe('TaxonomyReviewStep - prefix + suffix', () => {
  beforeEach(() => useDataLakeWizardStore.getState().resetWizard());
  afterEach(() => useDataLakeWizardStore.getState().resetWizard());

  it('renders each card as the shared prefix followed by its suffix', () => {
    seed('acme:', [mkTag({ suffix: 'type:report' })]);
    renderStep();

    expect(screen.getByTestId('taxonomy-tag-card').textContent).toContain('acme:type:report');
  });

  it('re-namespaces every card when the shared prefix changes', () => {
    seed('acme:', [mkTag({ suffix: 'type:report' }), mkTag({ suffix: 'topic:finance' })]);
    renderStep();

    fireEvent.change(prefixInput(), { target: { value: 'zzz:' } });

    const cards = screen.getAllByTestId('taxonomy-tag-card');
    expect(cards[0].textContent).toContain('zzz:type:report');
    expect(cards[1].textContent).toContain('zzz:topic:finance');
    // The store's single prefix moved, not any per-tag copy.
    expect(useDataLakeWizardStore.getState().taxonomy.prefix).toBe('zzz:');
  });

  it('edits only the suffix and writes it back to the store', () => {
    seed('acme:', [mkTag({ suffix: 'type:report' })]);
    renderStep();

    fireEvent.click(screen.getByTestId('taxonomy-tag-edit'));
    // The editable field holds only the suffix, not the prefix.
    expect(suffixInput().value).toBe('type:report');

    fireEvent.change(suffixInput(), { target: { value: 'type:renamed' } });
    fireEvent.click(screen.getByTestId('taxonomy-tag-save'));

    expect(useDataLakeWizardStore.getState().taxonomy.tags[0].suffix).toBe('type:renamed');
    expect(screen.getByTestId('taxonomy-tag-card').textContent).toContain('acme:type:renamed');
  });

  it('blocks saving an empty suffix (stays in edit mode, store unchanged)', () => {
    seed('acme:', [mkTag({ suffix: 'type:report' })]);
    renderStep();

    fireEvent.click(screen.getByTestId('taxonomy-tag-edit'));
    fireEvent.change(suffixInput(), { target: { value: '   ' } });

    const save =
      screen.getByTestId('taxonomy-tag-save').querySelector('button') ?? screen.getByTestId('taxonomy-tag-save');
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Enter must not save either; still editing, suffix unchanged.
    fireEvent.keyDown(suffixInput(), { key: 'Enter' });
    expect(screen.queryByTestId('taxonomy-tag-suffix-input')).not.toBeNull();
    expect(useDataLakeWizardStore.getState().taxonomy.tags[0].suffix).toBe('type:report');
  });

  it('shows the required error when the prefix is empty or too short', () => {
    seed('a', [mkTag({ suffix: 'type:report' })]);
    renderStep();

    expect(screen.getByTestId('taxonomy-tag-prefix-error')).toBeTruthy();

    fireEvent.change(prefixInput(), { target: { value: 'acme:' } });
    expect(screen.queryByTestId('taxonomy-tag-prefix-error')).toBeNull();
  });

  it('rejects the reserved datalake: namespace, which the server refuses at create', () => {
    // This field is the prefix's editable home, so it is where a user would type the one value
    // the create schema rejects. Catching it here beats a blocked Start Upload two steps on.
    seed('acme:', [mkTag({ suffix: 'type:report' })]);
    renderStep();
    expect(screen.queryByTestId('taxonomy-tag-prefix-error')).toBeNull();

    fireEvent.change(prefixInput(), { target: { value: 'datalake:' } });

    expect(screen.getByTestId('taxonomy-tag-prefix-error').textContent).toMatch(/reserved/i);
  });
});
