import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    expect(await screen.findByTestId('model-pricing-row-gpt-x')).toBeInTheDocument();
    expect(screen.getByTestId('model-pricing-source-gpt-x')).toHaveTextContent('seed');
    expect(screen.getByTestId('model-pricing-source-gpt-y')).toHaveTextContent('operator');
  });

  it('reprice requires a note before saving, then posts the new rates', async () => {
    renderCatalog();
    fireEvent.click(await screen.findByTestId('model-pricing-reprice-gpt-x'));

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
    await screen.findByTestId('model-pricing-row-gpt-x');
    expect(screen.queryByTestId('model-pricing-revert-gpt-x')).toBeNull();

    fireEvent.click(screen.getByTestId('model-pricing-revert-gpt-y'));
    fireEvent.click(screen.getByTestId('revert-confirm-btn'));

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][1]).toMatchObject({ modelId: 'gpt-y', action: 'revert-to-seed' });
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
    fireEvent.click(await screen.findByTestId('model-pricing-history-gpt-y'));

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('/api/admin/model-prices?history=gpt-y'));
    expect(await screen.findByTestId('history-drawer')).toBeInTheDocument();
    expect(screen.getAllByTestId('history-row')).toHaveLength(2);
  });
});
