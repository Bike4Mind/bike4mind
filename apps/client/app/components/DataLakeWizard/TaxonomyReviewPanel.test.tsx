import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeBatchDocument } from '@bike4mind/common';
import TaxonomyReviewPanel from './TaxonomyReviewPanel';

const { applyMutate, reanalyzeMutate, dismissMutate, confirmMock } = vi.hoisted(() => ({
  applyMutate: vi.fn(),
  reanalyzeMutate: vi.fn(),
  dismissMutate: vi.fn(),
  confirmMock: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  useApplyTaxonomySuggestions: () => ({ mutate: applyMutate, isPending: false }),
  useReanalyzeTaxonomy: () => ({ mutate: reanalyzeMutate, isPending: false }),
  useDismissTaxonomy: () => ({ mutate: dismissMutate, isPending: false }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmation: () => confirmMock,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const readyBatch = (): IDataLakeBatchDocument =>
  ({
    id: 'b1',
    dataLakeId: 'lake1',
    taxonomyStatus: 'ready',
    taxonomySuggestions: {
      tags: [
        {
          suffix: 'type:contract',
          originalName: 'acme:type:contract',
          strength: 0.95,
          source: 'ai',
          matchingFolders: ['legal'],
          deleted: false,
        },
        {
          suffix: 'topic:hr',
          originalName: 'acme:topic:hr',
          strength: 0.8,
          source: 'ai',
          matchingFolders: ['hr'],
          deleted: false,
        },
      ],
      fileAssignments: [],
    },
  }) as unknown as IDataLakeBatchDocument;

describe('TaxonomyReviewPanel', () => {
  beforeEach(() => {
    applyMutate.mockClear();
    reanalyzeMutate.mockClear();
    dismissMutate.mockClear();
    confirmMock.mockClear();
  });

  it('renders both suggested tags grouped by confidence tier', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getAllByTestId('taxonomy-tag-card')).toHaveLength(2);
    expect(screen.getByText(/High Confidence/i)).toBeInTheDocument();
    expect(screen.getByText(/Medium Confidence/i)).toBeInTheDocument();
  });

  it('deleting a tag removes it from what gets applied', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    fireEvent.click(screen.getAllByTestId('taxonomy-tag-delete')[0]);
    fireEvent.click(screen.getByTestId('taxonomy-apply-btn'));

    expect(applyMutate).toHaveBeenCalledTimes(1);
    const [sentTags] = applyMutate.mock.calls[0];
    const active = sentTags.filter((t: { deleted: boolean }) => !t.deleted);
    expect(active).toHaveLength(1);
    expect(active[0].originalName).toBe('acme:topic:hr');
  });

  it('shows the failure message and offers Re-analyze and Dismiss, but not Apply, when the batch failed', () => {
    const failed = { ...readyBatch(), taxonomyStatus: 'failed', taxonomyError: 'No OpenAI API key configured' };
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={failed as unknown as IDataLakeBatchDocument} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getByText(/No OpenAI API key configured/i)).toBeInTheDocument();
    expect(screen.queryByTestId('taxonomy-apply-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('taxonomy-dismiss-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('taxonomy-reanalyze-btn'));
    expect(reanalyzeMutate).toHaveBeenCalledTimes(1);
  });

  it('offers Dismiss for a ready batch too, not just failed', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getByTestId('taxonomy-dismiss-btn')).toBeInTheDocument();
  });

  it('clicking Dismiss asks for confirmation instead of dismissing immediately', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('taxonomy-dismiss-btn'));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(dismissMutate).not.toHaveBeenCalled();
  });

  it('dismissing closes the panel on success, only after confirmation, without touching apply or re-analyze', async () => {
    const onClose = vi.fn();
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={onClose} />
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('taxonomy-dismiss-btn'));
    const [confirmArgs] = confirmMock.mock.calls[0];
    await confirmArgs.onOk(); // simulates the user clicking the confirmation modal's Ok button

    expect(dismissMutate).toHaveBeenCalledTimes(1);
    const [, options] = dismissMutate.mock.calls[0];
    options.onSuccess();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(applyMutate).not.toHaveBeenCalled();
    expect(reanalyzeMutate).not.toHaveBeenCalled();
  });

  it('Close still works independently, without calling dismiss', () => {
    const onClose = vi.fn();
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={onClose} />
      </Wrapper>
    );

    fireEvent.click(screen.getByText('Close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dismissMutate).not.toHaveBeenCalled();
  });

  it('gives the icon-only Edit and Delete buttons an accessible name', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
  });

  it('gives the icon-only Save and Cancel buttons an accessible name while editing', () => {
    render(
      <Wrapper>
        <TaxonomyReviewPanel batch={readyBatch()} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    fireEvent.click(screen.getAllByTestId('taxonomy-tag-edit')[0]);

    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('keeps in-progress edits when taxonomySuggestions gets a new object reference but the same tag content', () => {
    // Simulates the batches-list response rebuilding a new array/object on every poll (Map +
    // spread) even when nothing about THIS batch's suggestions actually changed - e.g. because
    // some other batch left the list and shifted everyone after it. React Query's default
    // structural sharing would otherwise hand back a new reference here.
    const batch = readyBatch();
    const { rerender } = render(
      <Wrapper>
        <TaxonomyReviewPanel batch={batch} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    fireEvent.click(screen.getAllByTestId('taxonomy-tag-delete')[0]);
    expect(screen.getAllByTestId('taxonomy-tag-card')).toHaveLength(1);

    const sameContentNewObject = { ...batch, taxonomySuggestions: { ...batch.taxonomySuggestions } };
    rerender(
      <Wrapper>
        <TaxonomyReviewPanel batch={sameContentNewObject} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getAllByTestId('taxonomy-tag-card')).toHaveLength(1); // the delete survived
  });

  it('re-seeds and drops in-progress edits when tag content genuinely changes (e.g. a completed re-analyze)', () => {
    const batch = readyBatch();
    const { rerender } = render(
      <Wrapper>
        <TaxonomyReviewPanel batch={batch} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    fireEvent.click(screen.getAllByTestId('taxonomy-tag-delete')[0]);
    expect(screen.getAllByTestId('taxonomy-tag-card')).toHaveLength(1);

    const reanalyzed = {
      ...batch,
      taxonomySuggestions: {
        tags: [
          {
            suffix: 'type:invoice',
            originalName: 'acme:type:invoice',
            strength: 0.92,
            source: 'ai',
            matchingFolders: ['finance'],
            deleted: false,
          },
        ],
        fileAssignments: [],
      },
    };
    rerender(
      <Wrapper>
        <TaxonomyReviewPanel batch={reanalyzed} prefix="acme:" onClose={() => {}} />
      </Wrapper>
    );

    expect(screen.getAllByTestId('taxonomy-tag-card')).toHaveLength(1);
    expect(screen.getByText(/type:invoice/)).toBeInTheDocument(); // the freshly re-analyzed tag, not the pre-edit deleted one
  });
});
