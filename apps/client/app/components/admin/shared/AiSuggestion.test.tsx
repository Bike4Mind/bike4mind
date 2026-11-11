import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AI_ADVISORY_MARK, AiSuggestion, type AiSuggestionData, confidenceWord } from './AiSuggestion';

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);
const renderThemed = (ui: ReactNode) => render(ui, { wrapper: TestWrapper });

const suggestion = (overrides: Partial<AiSuggestionData> = {}): AiSuggestionData => ({
  id: 's1',
  proposal: 'Confirmed abuse',
  probability: 0.9,
  reasons: [{ text: 'Burst of signups from one network', evidenceHref: '/admin/evidence/1' }],
  model: 'example-model',
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...overrides,
});

describe('confidenceWord', () => {
  it.each([
    [0, 'low'],
    [0.49, 'low'],
    [0.5, 'medium'],
    [0.79, 'medium'],
    [0.8, 'high'],
    [1, 'high'],
  ] as const)('maps %s to %s', (probability, word) => {
    expect(confidenceWord(probability)).toBe(word);
  });

  it.each([null, undefined, Number.NaN, -0.1, 1.1])('has no word for %s', probability => {
    expect(confidenceWord(probability)).toBeNull();
  });
});

describe('AiSuggestion display', () => {
  it('renders nothing when there is no suggestion', () => {
    const { container } = renderThemed(<AiSuggestion variant="row" suggestion={null} />);
    expect(container).toBeEmptyDOMElement();
    const detail = renderThemed(<AiSuggestion variant="detail" suggestion={null} />);
    expect(detail.container).toBeEmptyDOMElement();
  });

  it('shows the row chip in the neutral tone with the mark, proposal and word', () => {
    renderThemed(<AiSuggestion variant="row" suggestion={suggestion()} data-testid="sug" />);
    const chip = screen.getByTestId('sug-chip');
    expect(chip).toHaveAttribute('data-tone', 'neutral');
    expect(chip).toHaveTextContent(`${AI_ADVISORY_MARK} Confirmed abuse, High`);
    expect(screen.getByTestId('sug')).toHaveAttribute('aria-label', expect.stringContaining('90%'));
  });

  it('leaves the word off the row chip when the probability is unknown', () => {
    renderThemed(<AiSuggestion variant="row" suggestion={suggestion({ probability: null })} data-testid="sug" />);
    expect(screen.getByTestId('sug-chip')).toHaveTextContent(`${AI_ADVISORY_MARK} Confirmed abuse`);
    expect(screen.getByTestId('sug-chip')).not.toHaveTextContent(/High|Medium|Low/);
  });

  it('shows the detail proposal, confidence word, reasons and meta', () => {
    renderThemed(<AiSuggestion variant="detail" suggestion={suggestion({ probability: 0.6 })} data-testid="sug" />);
    expect(screen.getByTestId('sug-proposal')).toHaveTextContent('Confirmed abuse');
    expect(screen.getByTestId('sug-confidence')).toHaveTextContent('Medium confidence');
    expect(screen.getByTestId('sug-reason-0').querySelector('a')).toHaveAttribute('href', '/admin/evidence/1');
    expect(screen.getByTestId('sug-meta')).toHaveTextContent('example-model');
    expect(screen.getByTestId('sug-meta')).toHaveTextContent('5 minutes ago');
  });

  it('caps the reasons at three', () => {
    const reasons = ['a', 'b', 'c', 'd'].map(text => ({ text }));
    renderThemed(<AiSuggestion variant="detail" suggestion={suggestion({ reasons })} data-testid="sug" />);
    expect(screen.getByTestId('sug-reason-2')).toHaveTextContent('c');
    expect(screen.queryByTestId('sug-reason-3')).toBeNull();
  });

  it('hides the reason list when there are none, and the word when the probability is unknown', () => {
    renderThemed(
      <AiSuggestion variant="detail" suggestion={suggestion({ reasons: [], probability: null })} data-testid="sug" />
    );
    expect(screen.queryByTestId('sug-reasons')).toBeNull();
    expect(screen.queryByTestId('sug-confidence')).toBeNull();
  });
});
