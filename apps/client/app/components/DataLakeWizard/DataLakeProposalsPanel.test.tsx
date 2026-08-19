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
    expect(screen.getByTestId('datalake-proposal-provenance').textContent).toContain('research_run');
    expect(screen.getByTestId('datalake-proposal-provenance').textContent).toContain('quarterly filings');
    expect(screen.getByTestId('datalake-proposal-tag')).toHaveTextContent('finance');
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

  it('flags a source a reviewer previously declined rather than hiding it', () => {
    renderPanel({ proposals: [proposal({ priorDisposition: 'declined' })] });

    expect(screen.getByTestId('datalake-proposal-previously-declined')).toBeInTheDocument();
  });

  it('flags a re-proposed approved source without claiming why it came back', () => {
    renderPanel({ proposals: [proposal({ priorDisposition: 'approved' })] });

    // Either its text changed or the admitted file left the lake - the chip must not assert one.
    expect(screen.getByTestId('datalake-proposal-previously-approved')).toHaveTextContent('Previously approved');
  });

  it('shows confidence as context only', () => {
    renderPanel({ proposals: [proposal({ confidence: 0.62 })] });

    expect(screen.getByTestId('datalake-proposal-confidence')).toHaveTextContent('Confidence 62%');
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
