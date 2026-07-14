import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

import { MarginDashboard } from './MarginDashboard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const CURRENT_MONTH = new Date().toISOString().slice(0, 7);

const providerRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  month: '2026-06',
  provider: 'openai',
  requests: 10,
  cogsUsd: 100,
  inputTokens: 1000,
  outputTokens: 500,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
});

const SETTLEMENT_ROWS = [
  {
    settledBasis: 'provider',
    requests: 2,
    creditsCharged: 90,
    writtenOffCredits: 5,
    inputTokenDelta: -30,
    outputTokenDelta: -10,
    deltaSampleSize: 2,
  },
  {
    settledBasis: 'local',
    requests: 3,
    creditsCharged: 25,
    writtenOffCredits: 0,
    inputTokenDelta: 0,
    outputTokenDelta: 0,
    deltaSampleSize: 0,
  },
];

/** URL-dispatched GET mock; tests override entries per case. */
let responses: Record<string, unknown>;

function setResponses(overrides: Partial<Record<string, unknown>> = {}) {
  responses = {
    'view=model-day': { targetCreditsPerUsd: 1200, rows: [] },
    'view=user': { targetCreditsPerUsd: 1200, rows: [] },
    'view=provider-month': { targetCreditsPerUsd: 1200, rows: [providerRow()] },
    'view=settlement': { targetCreditsPerUsd: 1200, rows: SETTLEMENT_ROWS },
    'provider-invoices': { invoices: [] },
    ...overrides,
  };
  mockGet.mockImplementation((url: string) => {
    const key = Object.keys(responses).find(k => url.includes(k));
    return Promise.resolve({ data: responses[key ?? ''] ?? { rows: [] } });
  });
}

function renderDashboard() {
  return render(
    <TestWrapper>
      <MarginDashboard />
    </TestWrapper>
  );
}

describe('MarginDashboard invoice reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResponses();
    mockPost.mockResolvedValue({ data: { invoice: {} } });
  });

  it('shows an Enter button when a closed month has no invoice', async () => {
    renderDashboard();
    expect(await screen.findByTestId('margin-invoice-enter-2026-06-openai')).toBeEnabled();
    expect(screen.getByTestId('margin-invoice-chip-2026-06-openai')).toHaveTextContent('no invoice');
  });

  it('disables entry for the current (partial) month', async () => {
    setResponses({
      'view=provider-month': { targetCreditsPerUsd: 1200, rows: [providerRow({ month: CURRENT_MONTH })] },
    });
    renderDashboard();
    expect(await screen.findByTestId(`margin-invoice-enter-${CURRENT_MONTH}-openai`)).toBeDisabled();
  });

  it.each([
    [981, 'match'], // 1.9% of invoice
    [979, 'review'], // 2.1%
    [901, 'review'], // 9.9%
    [899, 'gap'], // 10.1%
  ])('classifies cogs %s against a 1000 USD invoice as %s', async (cogsUsd, label) => {
    setResponses({
      'view=provider-month': { targetCreditsPerUsd: 1200, rows: [providerRow({ cogsUsd })] },
      'provider-invoices': { invoices: [{ month: '2026-06', provider: 'openai', invoiceUsd: 1000, note: 'INV-1' }] },
    });
    renderDashboard();
    expect(await screen.findByTestId('margin-invoice-chip-2026-06-openai')).toHaveTextContent(label);
  });

  it('renders the entered invoice amount and the signed delta', async () => {
    setResponses({
      'provider-invoices': { invoices: [{ month: '2026-06', provider: 'openai', invoiceUsd: 105, note: 'INV-1' }] },
    });
    renderDashboard();
    const cell = await screen.findByTestId('margin-invoice-cell-2026-06-openai');
    expect(cell).toHaveTextContent('$105.00');
    expect(screen.getByTestId('margin-invoice-delta-2026-06-openai')).toHaveTextContent('+$5.00');
  });

  it('submits an entry with a required note and refreshes', async () => {
    renderDashboard();
    fireEvent.click(await screen.findByTestId('margin-invoice-enter-2026-06-openai'));
    const modal = await screen.findByTestId('margin-invoice-modal');

    const save = screen.getByTestId('margin-invoice-save-btn');
    expect(save).toBeDisabled(); // empty amount + note

    fireEvent.change(within(modal).getByTestId('margin-invoice-usd-input').querySelector('input')!, {
      target: { value: '412.30' },
    });
    expect(save).toBeDisabled(); // note still empty

    fireEvent.change(within(modal).getByTestId('margin-invoice-note-input').querySelector('textarea')!, {
      target: { value: 'INV-1, Jun 1-30' },
    });
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/api/admin/provider-invoices', {
        month: '2026-06',
        provider: 'openai',
        invoiceUsd: 412.3,
        note: 'INV-1, Jun 1-30',
      })
    );
    // Successful save refetches (initial load + refresh).
    await waitFor(() =>
      expect(mockGet.mock.calls.filter(c => String(c[0]).includes('provider-invoices'))).toHaveLength(2)
    );
  });

  it('surfaces a failed save inside the modal', async () => {
    mockPost.mockRejectedValue({ response: { data: { message: 'note is required' } } });
    renderDashboard();
    fireEvent.click(await screen.findByTestId('margin-invoice-enter-2026-06-openai'));
    const modal = await screen.findByTestId('margin-invoice-modal');
    fireEvent.change(within(modal).getByTestId('margin-invoice-usd-input').querySelector('input')!, {
      target: { value: '10' },
    });
    fireEvent.change(within(modal).getByTestId('margin-invoice-note-input').querySelector('textarea')!, {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByTestId('margin-invoice-save-btn'));
    expect(await within(modal).findByTestId('margin-invoice-modal-error')).toHaveTextContent('note is required');
  });
});

describe('MarginDashboard settlement basis section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setResponses();
    mockPost.mockResolvedValue({ data: { invoice: {} } });
  });

  it('renders one row per basis with average token deltas', async () => {
    renderDashboard();
    const table = await screen.findByTestId('margin-settlement-table');
    const provider = within(table).getByTestId('margin-settlement-row-provider');
    // Averages: -30/2 and -10/2.
    expect(provider).toHaveTextContent('-15');
    expect(provider).toHaveTextContent('-5');
    const local = within(table).getByTestId('margin-settlement-row-local');
    expect(local).toHaveTextContent('n/a'); // deltaSampleSize 0
  });
});
