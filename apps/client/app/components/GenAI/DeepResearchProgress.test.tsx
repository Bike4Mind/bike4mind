import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import DeepResearchProgress from './DeepResearchProgress';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const START = Date.parse('2026-11-05T10:00:00.000Z');
const at = (sec: number) => new Date(START + sec * 1000).toISOString();
const longQuery = 'rare earth magnet supply chain '.repeat(8).trim();

const props = {
  startTime: START,
  completedSteps: 2,
  totalExpectedSteps: 4,
  activities: [
    {
      type: 'search' as const,
      status: 'pending' as const,
      message: `Searching with searxng for: "${longQuery}"`,
      timestamp: at(1),
      depth: 1,
    },
    {
      type: 'search' as const,
      status: 'complete' as const,
      message: `searxng found 2 results for: "${longQuery}"`,
      timestamp: at(4),
      depth: 1,
    },
    {
      type: 'extract' as const,
      status: 'pending' as const,
      message: 'Extracting content from https://example.com/a',
      timestamp: at(5),
      depth: 1,
    },
  ],
  sources: [
    {
      url: 'https://example.com/a',
      title: 'Magnets 101',
      description: 'Primer',
      status: 'found' as const,
      timestamp: at(4),
    },
    { url: 'https://example.org/b', title: 'Supply', description: 'Chain', status: 'found' as const, timestamp: at(4) },
  ],
};

describe('DeepResearchProgress', () => {
  it('shows one step per search, without the engine name, and the source being read', () => {
    render(<DeepResearchProgress {...props} />, { wrapper: Wrapper });
    expect(screen.getAllByTestId('deep-research-step-search')).toHaveLength(1);
    expect(screen.getByText('2 results')).toBeInTheDocument();
    expect(screen.getByTestId('deep-research-panel')).not.toHaveTextContent(/searxng/i);
    expect(screen.getByTestId('deep-research-status')).toHaveTextContent('Reading source 1 of 2');
    expect(screen.getByTestId('deep-research-percent')).toHaveTextContent('50%');
  });

  it('expands a clipped query on request, and offers no toggle for text that fits', () => {
    // jsdom does no layout: report the query as taller than its two-line clamp.
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.textContent === longQuery ? 90 : 0;
    });
    render(<DeepResearchProgress {...props} />, { wrapper: Wrapper });
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Full query' }));
    expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument();
    scrollHeight.mockRestore();
  });

  it('counts steps and sources on the tabs and lists sources as links', () => {
    render(<DeepResearchProgress {...props} />, { wrapper: Wrapper });
    expect(screen.getByTestId('deep-research-tab-activity')).toHaveTextContent(/^Activity\s*2$/);
    fireEvent.click(screen.getByTestId('deep-research-tab-sources'));
    const cards = screen.getAllByTestId('deep-research-source');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('href', 'https://example.com/a');
    expect(cards[1]).toHaveTextContent('example.org');
  });

  it('reads as done only once the turn has settled', () => {
    const done = { ...props, researchCompleted: true };
    const { rerender } = render(<DeepResearchProgress {...done} />, { wrapper: Wrapper });
    expect(screen.getByTestId('deep-research-status')).not.toHaveTextContent('Done');
    rerender(<DeepResearchProgress {...done} turnDone />);
    expect(screen.getByTestId('deep-research-status')).toHaveTextContent(
      'Done \u00b7 2 results \u00b7 2 sources \u00b7 0:05'
    );
    expect(screen.getByTestId('deep-research-percent')).toHaveTextContent('100%');
  });

  it('says it stopped when the turn settled without the research completing', () => {
    render(<DeepResearchProgress {...props} turnDone />, { wrapper: Wrapper });
    expect(screen.getByTestId('deep-research-status')).toHaveTextContent(/^Stopped/);
  });

  it('collapses to the header', () => {
    render(<DeepResearchProgress {...props} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand panel' })).toHaveAttribute('aria-expanded', 'false');
  });
});
