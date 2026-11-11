import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import {
  AI_ADVISORY_MARK,
  AI_OVERRIDE_REASONS,
  AiSuggestion,
  AiSuggestionBulkAccept,
  type AiSuggestionData,
  type AiSuggestionProps,
  confidenceWord,
} from './AiSuggestion';
import { ChangePreview } from './ChangePreview';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate }) }));

const theme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);
const renderThemed = (ui: ReactNode) => render(ui, { wrapper: TestWrapper });
const settle = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 0)));

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
    expect(screen.getByTestId('sug')).toHaveAttribute('role', 'img');
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

  it.each([
    'https://example.com/x',
    '//example.com/x',
    '/\\example.com/x',
    '/\t/example.com/x',
    '/\n/example.com/x',
    'data:text/html,x',
    'javascript:alert(1)',
  ])('renders a reason with the non-app href %s as plain text', evidenceHref => {
    renderThemed(
      <AiSuggestion
        variant="detail"
        suggestion={suggestion({ reasons: [{ text: 'Seen', evidenceHref }] })}
        data-testid="sug"
      />
    );
    expect(screen.getByTestId('sug-reason-0')).toHaveTextContent('Seen');
    expect(screen.getByTestId('sug-reason-0').querySelector('a')).toBeNull();
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

describe('AiSuggestion actions', () => {
  const renderDetail = (props: Partial<AiSuggestionProps> = {}) =>
    renderThemed(<AiSuggestion variant="detail" suggestion={suggestion()} data-testid="sug" {...props} />);

  it('renders no actions when no callbacks are given', () => {
    renderDetail();
    expect(screen.queryByTestId('sug-accept-btn')).toBeNull();
    expect(screen.queryByTestId('sug-override-btn')).toBeNull();
    expect(screen.queryByTestId('sug-dismiss-btn')).toBeNull();
  });

  it('accept hands off to the host without reporting a decision itself', () => {
    const onAccept = vi.fn();
    const onDecision = vi.fn();
    renderDetail({ onAccept, onDecision });
    fireEvent.click(screen.getByTestId('sug-accept-btn'));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('override asks why the AI was wrong, and the answer is optional', () => {
    const onOverride = vi.fn();
    renderDetail({ onOverride });
    fireEvent.click(screen.getByTestId('sug-override-btn'));
    expect(onOverride).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sug-override-continue-btn'));
    expect(onOverride).toHaveBeenLastCalledWith(undefined);

    fireEvent.click(screen.getByTestId('sug-override-btn'));
    fireEvent.click(screen.getByTestId('sug-why-1'));
    expect(screen.getByTestId('sug-why-1')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('sug-override-continue-btn'));
    expect(onOverride).toHaveBeenLastCalledWith(AI_OVERRIDE_REASONS[1]);
  });

  it('opens with the why-wrong picker when asked to', () => {
    const onOverride = vi.fn();
    renderDetail({ onOverride, initialOverriding: true });
    expect(screen.queryByTestId('sug-override-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('sug-why-0'));
    fireEvent.click(screen.getByTestId('sug-override-continue-btn'));
    expect(onOverride).toHaveBeenCalledWith(AI_OVERRIDE_REASONS[0]);
  });

  it('dismiss hides the suggestion and reports it', () => {
    const onDecision = vi.fn();
    renderDetail({ onDecision });
    fireEvent.click(screen.getByTestId('sug-dismiss-btn'));
    expect(screen.queryByTestId('sug')).toBeNull();
    expect(onDecision).toHaveBeenCalledWith({ suggestionId: 's1', status: 'dismissed' });
  });

  it('shows a new suggestion in the slot after the previous one was dismissed', () => {
    const { rerender } = renderThemed(
      <AiSuggestion
        variant="detail"
        suggestion={suggestion()}
        onDecision={vi.fn()}
        onOverride={vi.fn()}
        data-testid="sug"
      />
    );
    fireEvent.click(screen.getByTestId('sug-dismiss-btn'));
    expect(screen.queryByTestId('sug')).toBeNull();
    rerender(
      <AiSuggestion
        variant="detail"
        suggestion={suggestion({ id: 's2' })}
        onDecision={vi.fn()}
        onOverride={vi.fn()}
        data-testid="sug"
      />
    );
    expect(screen.getByTestId('sug-proposal')).toHaveTextContent('Confirmed abuse');
    expect(screen.getByTestId('sug-override-btn')).toBeTruthy();
  });

  it('shows Done by AI with Undo for an auto-applied suggestion', async () => {
    const onUndo = vi.fn();
    const onDecision = vi.fn();
    renderDetail({ suggestion: suggestion({ status: 'auto_applied' }), onUndo, onDecision, onAccept: vi.fn() });
    expect(screen.getByTestId('sug-done-chip')).toHaveTextContent('Done by AI');
    expect(screen.queryByTestId('sug-accept-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith({ suggestionId: 's1', status: 'undone' }));
  });

  it('reports undone only after the host revert resolves, and not when it rejects', async () => {
    let finish: () => void = () => {};
    const onDecision = vi.fn();
    const { unmount } = renderDetail({
      suggestion: suggestion({ status: 'auto_applied' }),
      onUndo: () => new Promise<void>(resolve => (finish = resolve)),
      onDecision,
    });
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    await waitFor(() => expect(screen.getByTestId('sug-undo-btn')).toBeDisabled());
    expect(onDecision).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onDecision).toHaveBeenCalledWith({ suggestionId: 's1', status: 'undone' }));
    unmount();

    const failing = vi.fn();
    renderDetail({
      suggestion: suggestion({ status: 'auto_applied' }),
      onUndo: () => Promise.reject(new Error('revert failed')),
      onDecision: failing,
    });
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    await waitFor(() => expect(screen.getByTestId('sug-undo-btn')).not.toBeDisabled());
    expect(failing).not.toHaveBeenCalled();
  });

  it('reverts once on a double click and drops undone when the suggestion changes or unmounts mid-revert', async () => {
    const finishes: Array<() => void> = [];
    const onUndo = vi.fn(() => new Promise<void>(resolve => finishes.push(resolve)));
    const onDecision = vi.fn();
    const props = { onUndo, onDecision, 'data-testid': 'sug' } as const;
    const { rerender, unmount } = renderDetail({ suggestion: suggestion({ status: 'auto_applied' }), ...props });
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    expect(onUndo).toHaveBeenCalledTimes(1);

    rerender(
      <AiSuggestion variant="detail" suggestion={suggestion({ id: 's2', status: 'auto_applied' })} {...props} />
    );
    expect(screen.getByTestId('sug-undo-btn')).not.toBeDisabled();
    finishes[0]();
    await settle();
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    expect(onUndo).toHaveBeenCalledTimes(2);
    unmount();
    finishes[1]();
    await settle();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('treats a synchronous throw from onUndo as a failed revert', async () => {
    const onDecision = vi.fn();
    renderDetail({
      suggestion: suggestion({ status: 'auto_applied' }),
      onUndo: () => {
        throw new Error('revert failed');
      },
      onDecision,
    });
    fireEvent.click(screen.getByTestId('sug-undo-btn'));
    await waitFor(() => expect(screen.getByTestId('sug-undo-btn')).not.toBeDisabled());
    expect(onDecision).not.toHaveBeenCalled();
  });

  it('routes a plain click on an in-app evidence link and leaves modified clicks to the browser', () => {
    navigate.mockClear();
    renderThemed(<AiSuggestion variant="detail" suggestion={suggestion()} data-testid="sug" />);
    const link = screen.getByTestId('sug-reason-0').querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/admin/evidence/1');
    fireEvent.click(link, { metaKey: true });
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith({ href: '/admin/evidence/1' });
  });
});

describe('AiSuggestionBulkAccept', () => {
  type Item = { id: string; probability: number | null; status?: AiSuggestionData['status'] };
  const toSuggestion = (item: Item): AiSuggestionData => ({
    id: item.id,
    proposal: 'Confirmed abuse',
    probability: item.probability,
    status: item.status,
  });
  const renderBulk = (items: Item[], onApply = vi.fn()) =>
    renderThemed(
      <AiSuggestionBulkAccept
        items={items}
        getSuggestion={toSuggestion}
        reversible
        renderPreview={high => (
          <ChangePreview before="Unreviewed" after={`${high.length} confirmed`} data-testid="bulk-preview" />
        )}
        onApply={onApply}
        data-testid="bulk"
      />
    );

  it('counts and applies only pending High suggestions, after a preview', async () => {
    const onApply = vi.fn();
    const items: Item[] = [
      { id: 'h1', probability: 0.95 },
      { id: 'h2', probability: 0.8, status: 'pending' },
      { id: 'm', probability: 0.6 },
      { id: 'n', probability: null },
      { id: 'done', probability: 0.9, status: 'auto_applied' },
    ];
    renderBulk(items, onApply);
    expect(screen.getByTestId('bulk-btn')).toHaveTextContent('Accept all High (2)');
    fireEvent.click(screen.getByTestId('bulk-btn'));
    expect(screen.getByTestId('bulk-preview-after')).toHaveTextContent('2 confirmed');
    expect(screen.getByTestId('bulk-dialog-reason-input')).toHaveValue('Accepted AI suggestion');
    fireEvent.click(screen.getByTestId('bulk-dialog-confirm-btn'));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith([items[0], items[1]], 'Accepted AI suggestion'));
  });

  it('is disabled with no High suggestions', () => {
    renderBulk([{ id: 'm', probability: 0.6 }]);
    expect(screen.getByTestId('bulk-btn')).toHaveTextContent('Accept all High (0)');
    expect(screen.getByTestId('bulk-btn')).toBeDisabled();
  });
});
