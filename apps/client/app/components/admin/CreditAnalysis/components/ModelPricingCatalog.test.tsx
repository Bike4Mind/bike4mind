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

import { ModelPricingCatalog } from './ModelPricingCatalog';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ROWS = [
  {
    modelId: 'gpt-x',
    unit: 'per_token',
    pricing: { '0': { input: 4e-6, output: 16e-6 } },
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    note: 'adapter-seed',
  },
  {
    modelId: 'gpt-y',
    unit: 'per_token',
    pricing: { '0': { input: 9e-6, output: 27e-6 } },
    effectiveFrom: '2026-07-05T00:00:00.000Z',
    note: 'manual reprice per invoice',
  },
];

function renderCatalog() {
  return render(
    <TestWrapper>
      <ModelPricingCatalog />
    </TestWrapper>
  );
}

describe('ModelPricingCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { rows: ROWS } });
    mockPost.mockResolvedValue({ data: { row: {} } });
  });

  it('renders in-force rows with seed/operator source chips', async () => {
    renderCatalog();
    expect(await screen.findByTestId('model-pricing-row-gpt-x-per_token')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-source-gpt-x-per_token')).toHaveTextContent('seed');
    expect(screen.getByTestId('model-pricing-source-gpt-y-per_token')).toHaveTextContent('operator');
  });

  it('reprice requires a note before saving, then posts the new rates', async () => {
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));

    const save = screen.getByTestId('reprice-save-btn');
    expect(save).toHaveAttribute('disabled');
    expect(mockPost).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('reprice-rate-0-input'), { target: { value: '0.000005' } });
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'openai price page 2026-07' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    const [url, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/admin/model-prices');
    expect(body).toMatchObject({
      modelId: 'gpt-x',
      note: 'openai price page 2026-07',
      pricing: { '0': { input: 0.000005, output: 16e-6 } },
    });
  });

  it('revert-to-seed is offered only on operator rows and posts the action after confirm', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    expect(screen.queryByTestId('model-pricing-revert-gpt-x-per_token')).toBeNull();

    fireEvent.click(screen.getByTestId('model-pricing-revert-gpt-y-per_token'));
    fireEvent.click(screen.getByTestId('revert-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({ modelId: 'gpt-y', action: 'revert-to-seed' });
  });

  it('formats non-token units at face value with a unit label (a per-minute rate must not be inflated x1M)', async () => {
    mockGet.mockResolvedValue({
      data: {
        rows: [
          ...ROWS,
          {
            modelId: 'voice-conversational',
            unit: 'per_minute',
            pricing: { '0': { input: 0.06, output: 0 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    renderCatalog();
    const row = await screen.findByTestId('model-pricing-row-voice-conversational-per_minute');
    expect(row).toHaveTextContent('$0.06');
    expect(row).not.toHaveTextContent('60,000');
    expect(row).toHaveTextContent('per minute');
  });

  it('surfaces the server validation message inside the open reprice modal on failure', async () => {
    mockPost.mockRejectedValue({
      message: 'Request failed with status code 400',
      response: { data: { message: "note 'adapter-seed' is reserved for seed provenance" } },
    });
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x-per_token'));
    fireEvent.change(screen.getByTestId('reprice-note-input'), { target: { value: 'adapter-seed' } });
    fireEvent.click(screen.getByTestId('reprice-save-btn'));

    const alert = await screen.findByTestId('reprice-modal-error');
    expect(alert).toHaveTextContent('reserved for seed provenance');
  });

  it('renders history as a diff with who and why; oldest row shows plain rates', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'invoice X',
            repricedBy: 'admin-1',
          },
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 4e-6, output: 16e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    expect(rows).toHaveLength(2);

    const newest = within(rows[0]);
    expect(newest.getByTestId('history-who')).toHaveTextContent('admin-1');
    expect(newest.getByText('invoice X')).toBeInTheDocument();
    // Diff against the older row: input $4 -> $9, output $16 -> $27.
    expect(newest.getByTestId('history-diff-0-input')).toHaveTextContent('$4');
    expect(newest.getByTestId('history-diff-0-input')).toHaveTextContent('$9');
    expect(newest.getByTestId('history-diff-0-output')).toHaveTextContent('$16');
    expect(newest.getByTestId('history-diff-0-output')).toHaveTextContent('$27');

    const oldest = within(rows[1]);
    expect(oldest.getByTestId('history-who')).toHaveTextContent('seed');
    expect(oldest.queryByTestId('history-diff-0-input')).not.toBeInTheDocument();
    expect(oldest.getByText(/\$4/)).toBeInTheDocument();
  });

  it('diffs every tier, not just the first (multi-tier reprice audit)', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '272000': { input: 1e-6, output: 6e-6 }, '1050000': { input: 3e-6, output: 9e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'long-context tier reprice',
            repricedBy: 'admin-1',
          },
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '272000': { input: 1e-6, output: 6e-6 }, '1050000': { input: 2e-6, output: 9e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    const newest = within(rows[0]);
    // Only the 1050000 tier's input changed ($2 -> $3); the first tier must not diff.
    const diff = newest.getByTestId('history-diff-1050000-input');
    expect(diff).toHaveTextContent('$2');
    expect(diff).toHaveTextContent('$3');
    expect(newest.queryByTestId('history-diff-272000-input')).not.toBeInTheDocument();
    expect(newest.queryByText('no rate changes')).not.toBeInTheDocument();
  });

  it('shows who performed a revert even though the row carries the seed note', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            unit: 'per_token',
            pricing: { '0': { input: 4e-6, output: 16e-6 } },
            effectiveFrom: '2026-07-06T00:00:00.000Z',
            note: 'adapter-seed',
            repricedBy: 'admin-1',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));
    const rows = await screen.findAllByTestId('history-row');
    expect(within(rows[0]).getByTestId('history-who')).toHaveTextContent('admin-1');
  });

  it('ignores a stale history response when a newer model was opened (no cross-model audit mixups)', async () => {
    renderCatalog();
    await screen.findByTestId('model-pricing-row-gpt-x-per_token');

    let resolveSlow: (v: unknown) => void = () => {};
    const slow = new Promise(resolve => (resolveSlow = resolve));
    mockGet.mockReturnValueOnce(slow); // gpt-x history: slow
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-x-per_token'));

    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'manual reprice per invoice',
          },
        ],
      },
    });
    fireEvent.click(screen.getByTestId('model-pricing-history-gpt-y-per_token'));
    await screen.findAllByTestId('history-row');

    resolveSlow({
      data: {
        history: [
          {
            modelId: 'gpt-x',
            pricing: { '0': { input: 1e-6, output: 2e-6 } },
            effectiveFrom: '2026-06-01T00:00:00.000Z',
            note: 'stale gpt-x row',
          },
        ],
      },
    });
    await waitFor(() => expect(screen.getByTestId('history-drawer')).toHaveTextContent('gpt-y'));
    expect(screen.getByTestId('history-drawer')).not.toHaveTextContent('stale gpt-x row');
  });

  it('history drawer fetches and lists the audit trail for one model', async () => {
    renderCatalog();
    mockGet.mockResolvedValueOnce({
      data: {
        history: [
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 9e-6, output: 27e-6 } },
            effectiveFrom: '2026-07-05T00:00:00.000Z',
            note: 'manual reprice per invoice',
          },
          {
            modelId: 'gpt-y',
            pricing: { '0': { input: 8e-6, output: 24e-6 } },
            effectiveFrom: '2026-07-01T00:00:00.000Z',
            note: 'adapter-seed',
          },
        ],
      },
    });
    fireEvent.click(await screen.findByTestId('model-pricing-history-gpt-y-per_token'));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/admin/model-prices?history=gpt-y'));
    expect(await screen.findByTestId('history-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
  });
});
