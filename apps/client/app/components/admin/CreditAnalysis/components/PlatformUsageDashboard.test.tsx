import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import {
  CreditHolderType,
  type IPlatformEndpointUsageResponse,
  type IPlatformUsageDashboardResponse,
} from '@bike4mind/common';

const mockUsePlatformUsage = vi.fn();
const mockUseEndpointUsage = vi.fn();

vi.mock('../hooks/usePlatformUsage', () => ({
  usePlatformUsage: (...args: unknown[]) => mockUsePlatformUsage(...args),
}));
vi.mock('../hooks/useEndpointUsage', () => ({
  useEndpointUsage: (...args: unknown[]) => mockUseEndpointUsage(...args),
}));
vi.mock('./ViewUserProfile', () => ({
  default: ({ userId }: { userId: string }) => <button data-testid={`view-profile-${userId}`}>View</button>,
}));
// ResponsiveContainer measures 0x0 in jsdom and renders no children, so the chart would be empty.
vi.mock('recharts', async importOriginal => ({
  ...(await importOriginal<typeof import('recharts')>()),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PlatformUsageDashboard } from './PlatformUsageDashboard';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const responseWith = (overrides: Partial<IPlatformUsageDashboardResponse>): IPlatformUsageDashboardResponse => ({
  days: 30,
  source: 'api',
  overTime: [],
  byFeature: [],
  byConsumer: [],
  byModel: [],
  totals: { requests: 0, cogsUsd: 0, creditsCharged: 0 },
  ...overrides,
});

const endpointResponseWith = (overrides: Partial<IPlatformEndpointUsageResponse>): IPlatformEndpointUsageResponse => ({
  windowDays: 90,
  endpoints: { byEndpoint: [], overTime: [] },
  ...overrides,
});

const setEndpointData = (
  overrides: Partial<IPlatformEndpointUsageResponse> = {},
  state: { isLoading?: boolean; isFetching?: boolean; error?: unknown; refetch?: () => void } = {}
) => {
  mockUseEndpointUsage.mockReturnValue({
    data: state.isLoading ? undefined : endpointResponseWith(overrides),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    ...state,
  });
};

beforeEach(() => {
  setEndpointData();
});

const setData = (overrides: Partial<IPlatformUsageDashboardResponse> = {}) => {
  mockUsePlatformUsage.mockReturnValue({
    data: responseWith(overrides),
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
  });
};

const renderDashboard = () =>
  render(
    <TestWrapper>
      <PlatformUsageDashboard />
    </TestWrapper>
  );

const lastFilters = () => mockUsePlatformUsage.mock.calls.at(-1)?.[0];

const pickOption = async (selectTestId: string, optionName: string) => {
  fireEvent.click(within(screen.getByTestId(selectTestId)).getByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: optionName }));
};

describe('PlatformUsageDashboard filters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setData();
  });

  it('defaults to the external-consumer view: source api, all owner types, 30 days', () => {
    renderDashboard();
    expect(lastFilters()).toEqual({ days: 30, source: 'api', ownerType: undefined });
  });

  it('sends no source when "All sources" is picked, and the chosen owner type', async () => {
    renderDashboard();
    await pickOption('platform-usage-source-select', 'All sources');
    await pickOption('platform-usage-owner-type-select', 'Organizations');
    expect(lastFilters()).toEqual({ days: 30, source: undefined, ownerType: CreditHolderType.Organization });
  });

  it('drives the window from the range toggle', () => {
    renderDashboard();
    fireEvent.click(within(screen.getByTestId('platform-usage-range-toggle')).getByRole('button', { name: '90d' }));
    expect(lastFilters()).toMatchObject({ days: 90 });
  });
});

describe('PlatformUsageDashboard consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies each consumer by key and owner, with a profile link for user owners', () => {
    setData({
      byConsumer: [
        {
          apiKeyId: 'k1',
          keyName: 'CI bot',
          keyPrefix: 'b4m_ab12',
          ownerId: 'u1',
          ownerType: CreditHolderType.User,
          ownerName: 'Ada',
          requests: 5,
          inputTokens: 100,
          outputTokens: 50,
          cogsUsd: 0.5,
          creditsCharged: 40,
        },
        {
          apiKeyId: 'k2',
          keyName: 'Partner sync',
          ownerId: 'o1',
          ownerType: CreditHolderType.Organization,
          ownerName: 'Acme',
          requests: 2,
          inputTokens: 10,
          outputTokens: 5,
          cogsUsd: 0.1,
          creditsCharged: 8,
        },
        { apiKeyId: 'k3', requests: 1, inputTokens: 1, outputTokens: 1, cogsUsd: 0, creditsCharged: 1 },
      ],
    });
    renderDashboard();

    const rows = within(screen.getByTestId('platform-usage-consumer-table')).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('CI bot');
    expect(rows[0]).toHaveTextContent('b4m_ab12');
    expect(rows[0]).toHaveTextContent('Ada');
    expect(within(rows[0]).getByTestId('view-profile-u1')).toBeInTheDocument();

    expect(rows[1]).toHaveTextContent('Partner sync');
    expect(rows[1]).toHaveTextContent('Org');
    expect(rows[1]).toHaveTextContent('Acme');
    expect(within(rows[1]).queryByRole('button')).not.toBeInTheDocument();

    // An unresolved key (deleted since) still shows its row rather than vanishing.
    expect(rows[2]).toHaveTextContent('Unknown key');
    expect(rows[2]).toHaveTextContent('Unknown owner');
  });
});

describe('PlatformUsageDashboard endpoint section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setData();
    setEndpointData();
  });

  it('renders the request-volume chart and endpoint table, labelled as having no credits', () => {
    setEndpointData({
      endpoints: {
        byEndpoint: [
          {
            endpoint: '/api/ai/v1/completions',
            method: 'POST',
            requests: 1200,
            avgResponseTimeMs: 840.4,
            p95ResponseTimeMs: 2100,
            errorRate: 0.025,
          },
        ],
        overTime: [],
      },
    });
    renderDashboard();

    const section = screen.getByTestId('platform-usage-endpoint-section');
    expect(section).toHaveTextContent('Request volume only - no credits or COGS');
    expect(within(section).getByTestId('platform-usage-endpoint-chart')).toBeInTheDocument();

    const row = within(screen.getByTestId('platform-usage-endpoint-table')).getAllByRole('row')[1];
    expect(row).toHaveTextContent('/api/ai/v1/completions');
    expect(row).toHaveTextContent('POST');
    expect(row).toHaveTextContent('1,200');
    expect(row).toHaveTextContent('2.5%');
    expect(row).toHaveTextContent('840 ms');
    expect(row).toHaveTextContent('2,100 ms');
  });

  it('defaults to all sources over the full 90 days, regardless of the page-wide source and range', () => {
    renderDashboard();
    expect(mockUseEndpointUsage.mock.calls.at(-1)).toEqual([undefined]);
    expect(screen.getByTestId('platform-usage-endpoint-section')).toHaveTextContent('Last 90 days');
  });

  it('keeps the endpoint filter independent of the credit filters, in both directions', async () => {
    renderDashboard();

    await pickOption('platform-usage-source-select', 'All sources');
    fireEvent.click(within(screen.getByTestId('platform-usage-range-toggle')).getByRole('button', { name: '7d' }));
    expect(mockUseEndpointUsage.mock.calls.at(-1)).toEqual([undefined]);

    await pickOption('platform-usage-endpoint-source-select', 'cli');
    expect(mockUseEndpointUsage.mock.calls.at(-1)).toEqual(['cli']);
    expect(lastFilters()).toEqual({ days: 7, source: undefined, ownerType: undefined });
  });

  it('notes that a source filter excludes rows logged before those fields existed, only while one is applied', async () => {
    const note = 'Filtering excludes requests logged before source was recorded.';
    renderDashboard();
    expect(screen.getByTestId('platform-usage-endpoint-section')).not.toHaveTextContent(note);

    await pickOption('platform-usage-endpoint-source-select', 'api');
    expect(screen.getByTestId('platform-usage-endpoint-section')).toHaveTextContent(note);

    await pickOption('platform-usage-endpoint-source-select', 'All sources');
    expect(screen.getByTestId('platform-usage-endpoint-section')).not.toHaveTextContent(note);
  });

  it('renders outside the credit loading and error states', () => {
    mockUsePlatformUsage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });
    renderDashboard();
    expect(screen.getByTestId('platform-usage-loading')).toBeInTheDocument();
    expect(screen.getByTestId('platform-usage-endpoint-table')).toBeInTheDocument();
  });

  it('shows its own spinner while loading, with no table', () => {
    setEndpointData({}, { isLoading: true });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-endpoint-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-usage-endpoint-table')).not.toBeInTheDocument();
  });

  it('shows its own error without affecting the credit sections', () => {
    setEndpointData({}, { error: new Error('Admin access required') });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-endpoint-error')).toHaveTextContent('Admin access required');
    expect(screen.queryByTestId('platform-usage-endpoint-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('platform-usage-consumer-table')).toBeInTheDocument();
  });
});

describe('PlatformUsageDashboard credit sections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows totals, the credits chart, and the feature and model breakdowns when there is usage', () => {
    const today = new Date().toISOString().slice(0, 10);
    setData({
      totals: { requests: 1200, cogsUsd: 3.5, creditsCharged: 400 },
      overTime: [{ day: today, requests: 1200, cogsUsd: 3.5, creditsCharged: 400 }],
      byFeature: [{ feature: 'completion_api', requests: 1200, cogsUsd: 3.5, creditsCharged: 400 }],
      byModel: [{ provider: 'openai', model: 'gpt-x', requests: 1200, cogsUsd: 3.5, creditsCharged: 400 }],
    });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-total-credits')).toHaveTextContent('400 credits');
    expect(screen.getByTestId('platform-usage-total-cogs')).toHaveTextContent('$3.50 COGS');
    expect(screen.getByTestId('platform-usage-total-requests')).toHaveTextContent('1,200 requests');
    expect(screen.getByTestId('platform-usage-credits-chart')).toBeInTheDocument();
    expect(within(screen.getByTestId('platform-usage-feature-table')).getByText('completion_api')).toBeInTheDocument();
    expect(within(screen.getByTestId('platform-usage-model-table')).getByText('openai / gpt-x')).toBeInTheDocument();
  });

  it('replaces the chart with an empty message when there are no requests', () => {
    setData();
    renderDashboard();

    expect(screen.queryByTestId('platform-usage-credits-chart')).not.toBeInTheDocument();
    // The empty breakdown tables repeat this message, so more than one match is expected.
    expect(screen.getAllByText('No usage in this window.').length).toBeGreaterThan(0);
  });
});

describe('PlatformUsageDashboard error banner', () => {
  const setError = (error: unknown) => {
    mockUsePlatformUsage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isFetching: false,
      error,
      refetch: vi.fn(),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the error message and no consumer table', () => {
    setError(new Error('Admin access required'));
    renderDashboard();

    expect(screen.getByTestId('platform-usage-error')).toHaveTextContent('Admin access required');
    expect(screen.queryByTestId('platform-usage-consumer-table')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when the error carries none', () => {
    setError({});
    renderDashboard();

    expect(screen.getByTestId('platform-usage-error')).toHaveTextContent('Failed to load platform usage');
  });
});

describe('PlatformUsageDashboard loading and refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a spinner and no tables while loading', () => {
    mockUsePlatformUsage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('platform-usage-consumer-table')).not.toBeInTheDocument();
  });

  it('refetches both the credit and endpoint queries when the refresh button is clicked', () => {
    const refetch = vi.fn();
    const refetchEndpoints = vi.fn();
    mockUsePlatformUsage.mockReturnValue({
      data: responseWith({}),
      isLoading: false,
      isFetching: false,
      error: null,
      refetch,
    });
    setEndpointData({}, { refetch: refetchEndpoints });
    renderDashboard();

    fireEvent.click(screen.getByTestId('platform-usage-refresh-btn'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetchEndpoints).toHaveBeenCalledTimes(1);
  });

  it('disables the refresh button while fetching', () => {
    mockUsePlatformUsage.mockReturnValue({
      data: responseWith({}),
      isLoading: false,
      isFetching: true,
      error: null,
      refetch: vi.fn(),
    });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-refresh-btn')).toBeDisabled();
  });

  it('disables the refresh button while only the endpoint query is fetching', () => {
    setData();
    setEndpointData({}, { isFetching: true });
    renderDashboard();

    expect(screen.getByTestId('platform-usage-refresh-btn')).toBeDisabled();
  });
});
