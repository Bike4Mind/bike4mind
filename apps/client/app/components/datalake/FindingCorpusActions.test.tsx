import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { MAX_TAXONOMY_TAGS } from '@bike4mind/common';
import type { IDataLakeFindingDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  applyPending: { value: false },
  lakeTags: vi.fn(),
}));

vi.mock('@client/app/hooks/data/dataLakes', () => ({
  serverRefusalMessage: (error: { serverMessage?: string }) => error.serverMessage,
  useApplyCorpusAction: () => ({ mutate: h.mutate, isPending: h.applyPending.value }),
  useLakeFileTags: (...args: unknown[]) => h.lakeTags(...args),
}));

import FindingCorpusActions from './FindingCorpusActions';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const finding = (over: Partial<IDataLakeFindingDocument> = {}): IDataLakeFindingDocument =>
  ({
    id: 'finding-1',
    lakeId: 'lake-1',
    kind: 'metric-disagreement',
    subject: 'annual recurring revenue',
    detector: 'lexical',
    documentCount: 2,
    status: 'open',
    firstSeenAt: new Date('2026-03-01T00:00:00Z'),
    lastSeenAt: new Date('2026-03-08T00:00:00Z'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    updatedAt: new Date('2026-03-08T00:00:00Z'),
    sources: [
      { fabFileId: 'file-a', fileName: 'investor-update.md', excerpt: 'ARR reached $4.2M in Q1.' },
      { fabFileId: 'file-b', fileName: 'board-deck.md', excerpt: 'ARR reached $3.7M in Q1.' },
    ],
    ...over,
  }) as IDataLakeFindingDocument;

const renderActions = (f = finding()) =>
  render(
    <TestWrapper>
      <FindingCorpusActions dataLakeId="lake-1" finding={f} />
    </TestWrapper>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.applyPending.value = false;
  h.lakeTags.mockReturnValue({ data: undefined, isLoading: true, isError: false });
});

describe('FindingCorpusActions', () => {
  it('offers the three controls on an open finding', () => {
    renderActions();

    expect(screen.getByTestId('finding-corpus-merge-btn')).toBeInTheDocument();
    expect(screen.getByTestId('finding-corpus-supersede-btn')).toBeInTheDocument();
    expect(screen.getByTestId('finding-corpus-retag-btn')).toBeInTheDocument();
  });

  it('offers nothing once the finding is closed', () => {
    renderActions(finding({ status: 'resolved' }));

    expect(screen.queryByTestId('finding-corpus-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('finding-corpus-merge-btn')).not.toBeInTheDocument();
  });

  it('names every affected file in the merge confirmation and posts keep/retire', () => {
    renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-merge-btn'));

    expect(screen.getByText('Kept: investor-update.md')).toBeInTheDocument();
    expect(screen.getByText('Retired: board-deck.md')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));

    expect(h.mutate).toHaveBeenCalledWith(
      {
        dataLakeId: 'lake-1',
        findingId: 'finding-1',
        body: { action: 'merge', keepFabFileId: 'file-a', retireFabFileIds: ['file-b'], note: undefined },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('lets a merge keep a different document and retire only the ones checked', () => {
    renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-merge-btn'));
    fireEvent.click(within(screen.getByTestId('finding-corpus-merge-keep-file-b')).getByRole('radio'));
    // Keep = b, and b is dropped from the retire set; a is now the only other, still checked.
    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));

    expect(h.mutate.mock.calls[0][0].body).toEqual({
      action: 'merge',
      keepFabFileId: 'file-b',
      retireFabFileIds: ['file-a'],
      note: undefined,
    });
  });

  it('posts a supersede with the chosen winner and loser', () => {
    renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-supersede-btn'));
    fireEvent.click(within(screen.getByTestId('finding-corpus-supersede-keep-file-b')).getByRole('radio'));
    fireEvent.click(within(screen.getByTestId('finding-corpus-supersede-retire-file-a')).getByRole('radio'));
    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));

    expect(h.mutate.mock.calls[0][0].body).toEqual({
      action: 'supersede',
      keepFabFileId: 'file-b',
      retireFabFileId: 'file-a',
      note: undefined,
    });
  });

  it('moves the other side when the same document is chosen as kept and retired', () => {
    renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-supersede-btn'));
    fireEvent.click(within(screen.getByTestId('finding-corpus-supersede-keep-file-b')).getByRole('radio'));
    expect(within(screen.getByTestId('finding-corpus-supersede-retire-file-a')).getByRole('radio')).toBeChecked();
    expect(screen.getByTestId('finding-corpus-confirm-btn')).toBeEnabled();

    fireEvent.click(within(screen.getByTestId('finding-corpus-supersede-retire-file-b')).getByRole('radio'));
    expect(within(screen.getByTestId('finding-corpus-supersede-keep-file-a')).getByRole('radio')).toBeChecked();
    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));

    expect(h.mutate.mock.calls[0][0].body).toMatchObject({ keepFabFileId: 'file-a', retireFabFileId: 'file-b' });
  });

  it('shows a server refusal inline in the supersede dialog and clears it on a new choice', () => {
    h.mutate.mockImplementationOnce((_vars, options) => options.onError({ serverMessage: 'would create a cycle' }));
    renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-supersede-btn'));
    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));
    expect(screen.getByTestId('finding-corpus-supersede-error')).toHaveTextContent('would create a cycle');

    fireEvent.click(within(screen.getByTestId('finding-corpus-supersede-keep-file-b')).getByRole('radio'));
    expect(screen.queryByTestId('finding-corpus-supersede-error')).not.toBeInTheDocument();
  });

  it('blocks a retag until the current tags have loaded, then posts the complete edited set', () => {
    const { rerender } = renderActions();

    fireEvent.click(screen.getByTestId('finding-corpus-retag-btn'));

    // No seed yet: submitting would send `[]`, and replace semantics would strip every tag.
    expect(screen.getByTestId('finding-corpus-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('finding-corpus-retag-loading')).toBeInTheDocument();

    h.lakeTags.mockReturnValue({
      data: { prefix: 'lk:', current: ['lk:finance'] },
      isLoading: false,
      isError: false,
    });
    rerender(
      <TestWrapper>
        <FindingCorpusActions dataLakeId="lake-1" finding={finding()} />
      </TestWrapper>
    );

    expect(screen.getByTestId('finding-corpus-confirm-btn')).not.toBeDisabled();

    fireEvent.change(screen.getByTestId('finding-corpus-retag-add-input'), { target: { value: 'lk:legal' } });
    fireEvent.click(screen.getByTestId('finding-corpus-retag-add-btn'));
    fireEvent.click(screen.getByTestId('finding-corpus-retag-remove-lk:finance'));
    expect(screen.queryByTestId('finding-corpus-retag-remove-lk:finance')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('finding-corpus-confirm-btn'));

    expect(h.mutate.mock.calls[0][0].body).toEqual({
      action: 'retag',
      fabFileId: 'file-a',
      tags: ['lk:legal'],
      note: undefined,
    });
  });

  it('rejects a tag outside the lake prefix before it can be submitted', () => {
    renderActions();
    h.lakeTags.mockReturnValue({ data: { prefix: 'lk:', current: [] }, isLoading: false, isError: false });

    fireEvent.click(screen.getByTestId('finding-corpus-retag-btn'));
    fireEvent.change(screen.getByTestId('finding-corpus-retag-add-input'), { target: { value: 'other:x' } });
    fireEvent.click(screen.getByTestId('finding-corpus-retag-add-btn'));

    expect(screen.getByTestId('finding-corpus-retag-invalid')).toHaveTextContent('lk:');
  });

  it('refuses to add past the tag cap the server enforces', () => {
    renderActions();
    const full = Array.from({ length: MAX_TAXONOMY_TAGS }, (_, i) => `lk:t${i}`);
    h.lakeTags.mockReturnValue({ data: { prefix: 'lk:', current: full }, isLoading: false, isError: false });

    fireEvent.click(screen.getByTestId('finding-corpus-retag-btn'));
    fireEvent.change(screen.getByTestId('finding-corpus-retag-add-input'), { target: { value: 'lk:one-more' } });
    fireEvent.click(screen.getByTestId('finding-corpus-retag-add-btn'));

    expect(screen.getByTestId('finding-corpus-retag-invalid')).toHaveTextContent(/tag limit/i);
  });
});
