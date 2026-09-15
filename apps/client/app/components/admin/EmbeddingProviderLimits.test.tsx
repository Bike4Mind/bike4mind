import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { EmbeddingProviderLimits } from './EmbeddingProviderLimits';

const { mockGet, mockSettingValue } = vi.hoisted(() => ({ mockGet: vi.fn(), mockSettingValue: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: (...a: unknown[]) => mockGet(...a) } }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => mockSettingValue(key),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={appTheme}>
        <EmbeddingProviderLimits />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingValue.mockImplementation((key: string) => (key === 'dataLakeEmbeddingMaxTokensPerMinute' ? 600000 : 120));
});

describe('EmbeddingProviderLimits', () => {
  it('does not call the provider until asked', async () => {
    renderPanel();
    // Reading the ceiling costs a real provider call; opening the settings page must not spend it.
    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.getByTestId('embedding-limits-check-btn')).toBeInTheDocument();
  });

  it('shows measured limits and how the configured lever compares', async () => {
    mockGet.mockResolvedValue({
      data: {
        supported: true,
        provider: 'openai',
        model: 'text-embedding-ada-002',
        limits: { limitTokens: 10_000_000, limitRequests: 10_000, remainingTokens: null, remainingRequests: null },
        measuredAt: new Date().toISOString(),
      },
    });

    renderPanel();
    await userEvent.click(screen.getByTestId('embedding-limits-check-btn'));

    await waitFor(() => expect(screen.getByTestId('embedding-limits-result')).toBeInTheDocument());
    expect(screen.getByTestId('embedding-limits-tokens')).toHaveTextContent('10,000,000 tokens/min');

    // The point of the panel: a lever at 6% of capacity should be legible as such, and the
    // suggestion should be 60% of measured rather than of anything else.
    const comparison = screen.getByTestId('embedding-limits-comparison');
    expect(comparison).toHaveTextContent('6% of measured capacity');
    expect(comparison).toHaveTextContent('6,000,000');
  });

  it('explains a provider that cannot report limits', async () => {
    mockGet.mockResolvedValue({
      data: {
        supported: false,
        provider: 'bedrock',
        model: 'amazon.titan-embed-text-v2:0',
        reason: 'Bedrock publishes quotas through AWS Service Quotas rather than response headers.',
      },
    });

    renderPanel();
    await userEvent.click(screen.getByTestId('embedding-limits-check-btn'));

    await waitFor(() => expect(screen.getByTestId('embedding-limits-unavailable')).toBeInTheDocument());
    expect(screen.getByTestId('embedding-limits-unavailable')).toHaveTextContent('Service Quotas');
  });

  it('says a failed read is unknown, not unlimited', async () => {
    // The dangerous misreading: an admin seeing an error and concluding there is no ceiling.
    mockGet.mockRejectedValue(new Error('network down'));

    renderPanel();
    await userEvent.click(screen.getByTestId('embedding-limits-check-btn'));

    await waitFor(() => expect(screen.getByTestId('embedding-limits-error')).toBeInTheDocument());
    expect(screen.getByTestId('embedding-limits-error')).toHaveTextContent('unknown, not unlimited');
  });

  it('renders a partial reading without inventing the missing dimension', async () => {
    mockGet.mockResolvedValue({
      data: {
        supported: true,
        provider: 'voyageai',
        model: 'voyage-3',
        limits: { limitTokens: null, limitRequests: 2_000, remainingTokens: null, remainingRequests: null },
        measuredAt: new Date().toISOString(),
      },
    });

    renderPanel();
    await userEvent.click(screen.getByTestId('embedding-limits-check-btn'));

    await waitFor(() => expect(screen.getByTestId('embedding-limits-result')).toBeInTheDocument());
    expect(screen.getByTestId('embedding-limits-tokens')).toHaveTextContent('not reported');
    expect(screen.queryByTestId('embedding-limits-comparison')).not.toBeInTheDocument();
  });
});
