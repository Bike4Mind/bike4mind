import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IDataLakeProposalDocument } from '@bike4mind/common';
import { DataLakeProposalsPanel } from './DataLakeProposalsPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const proposal = (over: Partial<IDataLakeProposalDocument> = {}): IDataLakeProposalDocument =>
  ({
    id: 'prop-1',
    dataLakeId: 'lake-1',
    status: 'pending',
    sourceUrl: 'https://example.com/report',
    canonicalSourceKey: 'https://example.com/report',
    title: 'Quarterly report',
    excerpt: 'a sample of the source text',
    proposedTags: ['finance'],
    provenance: { producer: 'research_run', query: 'quarterly filings', retrievedAt: new Date('2026-08-01') },
    ...over,
  }) as IDataLakeProposalDocument;

const renderPanel = (props: Partial<React.ComponentProps<typeof DataLakeProposalsPanel>> = {}) => {
  const onApprove = vi.fn();
  const onDecline = vi.fn();
  render(
    <Wrapper>
      <DataLakeProposalsPanel
        proposals={[proposal()]}
        isLoading={false}
        error={null}
        onApprove={onApprove}
        onDecline={onDecline}
        {...props}
      />
    </Wrapper>
  );
  return { onApprove, onDecline };
};

describe('DataLakeProposalsPanel', () => {
  it('shows the source, provenance and proposed tags a reviewer decides from', () => {
    renderPanel();

    expect(screen.getByTestId('datalake-proposal-source')).toHaveAttribute('href', 'https://example.com/report');
    // The producer is a machine token on the row; it renders into an English sentence here, so a
    // reviewer reads "a research run" rather than "research_run".
    expect(screen.getByTestId('datalake-proposal-provenance').textContent).toContain('Found by a research run');
    expect(screen.getByTestId('datalake-proposal-provenance').textContent).toContain('quarterly filings');
    expect(screen.getByTestId('datalake-proposal-tag')).toHaveTextContent('finance');
  });

  // `producer` is free-form by design, so an unmapped one must still say something rather than
  // rendering blank.
  it('falls back to the raw producer token for a producer it has no name for', () => {
    renderPanel({
      proposals: [proposal({ provenance: { producer: 'some_future_crawler', retrievedAt: new Date() } })],
    });
    expect(screen.getByTestId('datalake-proposal-provenance').textContent).toContain('Found by some_future_crawler');
  });

  it('frames the excerpt as source text that has not been reviewed', () => {
    renderPanel();

    const excerpt = screen.getByTestId('datalake-proposal-excerpt');
    expect(excerpt.textContent).toContain('not yet reviewed');
    expect(excerpt.textContent).toContain('a sample of the source text');
  });

  it('opens the source in a new tab without leaking the referrer', () => {
    renderPanel();

    const link = screen.getByTestId('datalake-proposal-source');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('approves one proposal at a time - there is no bulk or auto approve control', () => {
    const { onApprove } = renderPanel({ proposals: [proposal(), proposal({ id: 'prop-2' })] });

    expect(screen.getAllByTestId('datalake-proposal-approve-btn')).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId('datalake-proposal-approve-btn')[0]);

    expect(onApprove).toHaveBeenCalledWith('prop-1');
  });

  it('takes a decline reason before declining', () => {
    const { onDecline } = renderPanel();

    fireEvent.click(screen.getByTestId('datalake-proposal-decline-btn'));
    fireEvent.change(screen.getByTestId('datalake-proposal-decline-reason'), { target: { value: 'paywalled' } });
    fireEvent.click(screen.getByTestId('datalake-proposal-decline-confirm-btn'));

    expect(onDecline).toHaveBeenCalledWith('prop-1', 'paywalled');
  });

  it('declines with no reason when the reviewer gives none', () => {
    const { onDecline } = renderPanel();

    fireEvent.click(screen.getByTestId('datalake-proposal-decline-btn'));
    fireEvent.click(screen.getByTestId('datalake-proposal-decline-confirm-btn'));

    expect(onDecline).toHaveBeenCalledWith('prop-1', undefined);
  });

  it('cancels a decline without recording anything', () => {
    const { onDecline } = renderPanel();

    fireEvent.click(screen.getByTestId('datalake-proposal-decline-btn'));
    fireEvent.click(screen.getByTestId('datalake-proposal-decline-cancel-btn'));

    expect(onDecline).not.toHaveBeenCalled();
    expect(screen.getByTestId('datalake-proposal-approve-btn')).toBeInTheDocument();
  });

  // The spinner used to be unreachable: the row left decline mode in the same tick as the click, so a
  // decline showed no in-flight feedback and looked like nothing had happened.
  it('holds the decline row open after confirming so the in-flight state is visible', () => {
    const { onDecline } = renderPanel();

    fireEvent.click(screen.getByTestId('datalake-proposal-decline-btn'));
    fireEvent.change(screen.getByTestId('datalake-proposal-decline-reason'), { target: { value: 'paywalled' } });
    fireEvent.click(screen.getByTestId('datalake-proposal-decline-confirm-btn'));

    expect(onDecline).toHaveBeenCalledWith('prop-1', 'paywalled');
    // Still in decline mode. Tearing it down in the same tick as the click (as this did) unmounted
    // the busy button before it could render, so a decline showed no feedback at all - it read as a
    // click that did nothing. The row leaves when the server confirms and the list refetches.
    expect(screen.getByTestId('datalake-proposal-decline-confirm-btn')).toBeInTheDocument();
    expect(screen.getByTestId('datalake-proposal-decline-reason')).toHaveValue('paywalled');
  });

  it('explains what each action actually does', () => {
    renderPanel();

    // Approving is a live outbound fetch and declining is remembered - neither is guessable from the
    // button labels alone.
    expect(screen.getByTestId('datalake-proposals-help')).toHaveTextContent(/Approving fetches the page now/);
    expect(screen.getByTestId('datalake-proposals-help')).toHaveTextContent(/Declining is remembered/);
  });

  it('reads as caught up rather than broken when the queue is empty', () => {
    renderPanel({ proposals: [] });

    expect(screen.getByTestId('datalake-proposals-empty')).toHaveTextContent(/Nothing is waiting for review/);
  });

  it('flags a source a reviewer previously declined rather than hiding it', () => {
    renderPanel({ proposals: [proposal({ priorDisposition: 'declined' })] });

    expect(screen.getByTestId('datalake-proposal-previously-declined')).toBeInTheDocument();
  });

  it('flags a re-proposed approved source without claiming why it came back', () => {
    renderPanel({ proposals: [proposal({ priorDisposition: 'approved' })] });

    // Either its text changed or the admitted file left the lake - the chip must not assert one.
    expect(screen.getByTestId('datalake-proposal-previously-approved')).toHaveTextContent('Previously approved');
  });

  it('labels the score as relevance and shows the reason behind it', () => {
    renderPanel({ proposals: [proposal({ confidence: 0.62, rationale: 'covers the Q3 filings' })] });

    expect(screen.getByTestId('datalake-proposal-confidence')).toHaveTextContent('Relevance 62%');
    expect(screen.getByTestId('datalake-proposal-rationale')).toHaveTextContent('covers the Q3 filings');
  });

  it('omits the reason when the producer gave none', () => {
    renderPanel({ proposals: [proposal({ confidence: 0.62 })] });

    expect(screen.queryByTestId('datalake-proposal-rationale')).not.toBeInTheDocument();
  });

  it('says the proposed tags are suggestions that approval does not apply', () => {
    renderPanel();

    expect(screen.getByTestId('datalake-proposal-tags')).toHaveTextContent(/not applied/);
    expect(screen.getByTestId('datalake-proposals-help')).toHaveTextContent(/suggested tags are not applied/);
  });

  it('collapses a long excerpt until the reviewer asks for the rest', () => {
    const long = `${'a'.repeat(300)}END`;
    renderPanel({ proposals: [proposal({ excerpt: long })] });

    expect(screen.getByTestId('datalake-proposal-excerpt-text').textContent).not.toContain('END');
    fireEvent.click(screen.getByTestId('datalake-proposal-excerpt-toggle'));
    expect(screen.getByTestId('datalake-proposal-excerpt-text')).toHaveTextContent(long);
    expect(screen.getByTestId('datalake-proposal-excerpt-toggle')).toHaveTextContent('Show less');
  });

  it('shows a short excerpt whole, with no toggle', () => {
    renderPanel();

    expect(screen.queryByTestId('datalake-proposal-excerpt-toggle')).not.toBeInTheDocument();
  });

  it('orders by relevance by default, unscored last, and can switch to newest first', () => {
    renderPanel({
      proposals: [
        proposal({ id: 'new-unscored', title: 'Unscored' }),
        proposal({ id: 'mid', title: 'Mid', confidence: 0.5 }),
        proposal({ id: 'top', title: 'Top', confidence: 0.9 }),
      ],
    });
    const titles = () => screen.getAllByTestId('datalake-proposal-title').map(t => t.textContent);

    expect(titles()).toEqual(['Top', 'Mid', 'Unscored']);

    fireEvent.click(screen.getByRole('combobox', { name: 'Sort proposals' }));
    fireEvent.click(screen.getByRole('option', { name: 'Newest first' }));
    expect(titles()).toEqual(['Unscored', 'Mid', 'Top']);
  });

  it('switches between the pending queue and declined proposals', () => {
    const onViewChange = vi.fn();
    renderPanel({ onViewChange });

    fireEvent.click(screen.getByTestId('datalake-proposals-view-declined'));

    expect(onViewChange).toHaveBeenCalledWith('declined');
  });

  it('shows a declined proposal with its reason and restores it', () => {
    const onRestore = vi.fn();
    renderPanel({
      view: 'declined',
      onViewChange: vi.fn(),
      onRestore,
      proposals: [
        proposal({
          status: 'declined',
          excerpt: null,
          declineReason: 'paywalled',
          reviewedAt: new Date('2026-09-01'),
        }),
      ],
    });

    expect(screen.getByTestId('datalake-proposal-decline-record')).toHaveTextContent('paywalled');
    expect(screen.queryByTestId('datalake-proposal-approve-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('datalake-proposals-sort')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('datalake-proposal-restore-btn'));

    expect(onRestore).toHaveBeenCalledWith('prop-1');
  });

  it('disables restore on an older tombstone a later decline of the same source superseded', () => {
    renderPanel({
      view: 'declined',
      onRestore: vi.fn(),
      proposals: [
        proposal({ id: 'newer', status: 'declined', excerpt: null }),
        proposal({ id: 'older', status: 'declined', excerpt: null }),
      ],
    });

    const [newer, older] = screen.getAllByTestId('datalake-proposal-restore-btn');
    expect(newer).not.toBeDisabled();
    expect(older).toBeDisabled();
    expect(screen.getAllByTestId('datalake-proposal-superseded')).toHaveLength(1);
  });

  it('disables restore on a declined row whose source now has a newer pending proposal', () => {
    renderPanel({
      view: 'declined',
      onRestore: vi.fn(),
      proposals: [proposal({ id: 'declined-1', status: 'declined', excerpt: null })],
      pendingCanonicalSourceKeys: new Set(['https://example.com/report']),
    });

    expect(screen.getByTestId('datalake-proposal-restore-btn')).toBeDisabled();
    expect(screen.getByTestId('datalake-proposal-superseded')).toBeInTheDocument();
  });

  it('leaves restore enabled on a declined row whose source has no pending proposal', () => {
    renderPanel({
      view: 'declined',
      onRestore: vi.fn(),
      proposals: [proposal({ id: 'declined-1', status: 'declined', excerpt: null })],
      pendingCanonicalSourceKeys: new Set(['https://example.com/some-other-report']),
    });

    expect(screen.getByTestId('datalake-proposal-restore-btn')).not.toBeDisabled();
    expect(screen.queryByTestId('datalake-proposal-superseded')).not.toBeInTheDocument();
  });

  it('reads as empty, not caught up, when nothing has been declined', () => {
    renderPanel({ view: 'declined', onViewChange: vi.fn(), proposals: [] });

    expect(screen.getByTestId('datalake-proposals-empty')).toHaveTextContent(/Nothing has been declined/);
    // The toggle survives an empty view, so the reviewer can get back.
    expect(screen.getByTestId('datalake-proposals-view-pending')).toBeInTheDocument();
  });

  it('omits confidence entirely when the producer supplied none', () => {
    renderPanel();

    expect(screen.queryByTestId('datalake-proposal-confidence')).not.toBeInTheDocument();
  });

  it('renders an empty queue as an explanation, not an error', () => {
    renderPanel({ proposals: [] });

    expect(screen.getByTestId('datalake-proposals-empty')).toBeInTheDocument();
  });

  it('renders loading and error states', () => {
    const { unmount } = render(
      <Wrapper>
        <DataLakeProposalsPanel proposals={undefined} isLoading error={null} onApprove={vi.fn()} onDecline={vi.fn()} />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-proposals-loading')).toBeInTheDocument();
    unmount();

    render(
      <Wrapper>
        <DataLakeProposalsPanel
          proposals={undefined}
          isLoading={false}
          error={new Error('boom')}
          onApprove={vi.fn()}
          onDecline={vi.fn()}
        />
      </Wrapper>
    );
    expect(screen.getByTestId('datalake-proposals-error')).toBeInTheDocument();
  });
});
