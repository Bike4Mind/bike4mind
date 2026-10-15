import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CREDITS_PER_USD_COST, CreditHolderType, ModelBackend, type ModelInfo } from '@bike4mind/common';
import CreditAnalyticsTabContent from './CreditAnalyticsTabContent';
import { formatCreditsPer1M } from './modelPricingRows';

const perM = (usd: number) => usd / 1_000_000;

function textModel(id: string, name: string, backend: ModelBackend, input: number, output: number): ModelInfo {
  return {
    id: id as ModelInfo['id'],
    type: 'text',
    name,
    backend,
    contextWindow: 1_000_000,
    max_tokens: 32_000,
    supportsImageVariation: false,
    pricing: { 1_000_000: { input: perM(input), output: perM(output) } },
  };
}

// What the picker sees: a dated GPT-4.1 plus its discovered alias, and Opus on two backends.
const accessibleTextModels = [
  textModel('gpt-4.1-2025-04-14', 'GPT-4.1', ModelBackend.OpenAI, 2, 8),
  textModel('gpt-4.1', 'GPT-4.1', ModelBackend.OpenAI, 2, 8),
  textModel('gpt-4.1-nano-2025-04-14', 'GPT-4.1 Nano', ModelBackend.OpenAI, 0.1, 0.4),
  textModel('global.anthropic.claude-opus-5-5', 'Claude 5.5 Opus', ModelBackend.Bedrock, 5, 25),
  textModel('claude-opus-5-5', 'Claude Opus 5.5', ModelBackend.Anthropic, 5, 25),
];

// Video rows carry their model id, so the catalog name has to reach the pie the same way text does.
const accessibleVideoModels: ModelInfo[] = [
  {
    id: 'veo-3' as ModelInfo['id'],
    type: 'video',
    name: 'Veo 3',
    backend: ModelBackend.Gemini,
    contextWindow: 0,
    max_tokens: 0,
    pricing: {},
  },
];

const hoisted = vi.hoisted(() => ({
  currentUser: { id: 'user_1', currentCredits: 1000 } as Record<string, unknown>,
  transactions: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const line = vi.hoisted(() => ({ series: [] as Array<{ id: string; data: Array<{ x: string; y: number }> }> }));
vi.mock('@nivo/line', () => ({
  ResponsiveLine: ({ data }: { data: typeof line.series }) => {
    line.series = data;
    return null;
  },
}));
const pie = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('@nivo/pie', () => ({
  ResponsivePie: ({ data }: { data: unknown[] }) => {
    pie.data = data;
    return null;
  },
}));
// Records the props the tab passes down; also keeps the real dashboard (and its react-query
// hooks, which would need a QueryClientProvider) out of this suite.
const dashboard = vi.hoisted(() => ({ props: null as { ownerType: unknown; ownerId?: string } | null }));
vi.mock('@client/app/components/admin/CreditAnalysis/components/UsageDashboard', () => ({
  UsageDashboard: (props: { ownerType: unknown; ownerId?: string }) => {
    dashboard.props = props;
    return <div data-testid="usage-dashboard" />;
  },
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: hoisted.currentUser }),
}));
vi.mock('@client/app/hooks/data/credits', () => ({
  useGetCreditTransactions: () => ({ data: hoisted.transactions, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleTextModels,
    accessibleImageModels: [],
    accessibleVideoModels,
    isLoading: false,
    isModelsError: false,
  }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('CreditAnalyticsTabContent model pricing', () => {
  it('lists one row per model, labelling Bedrock instead of hiding a backend', () => {
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(screen.getAllByTestId(/^model-pricing-row-/).map(row => row.dataset.testid)).toEqual([
      'model-pricing-row-global.anthropic.claude-opus-5-5',
      'model-pricing-row-claude-opus-5-5',
      'model-pricing-row-gpt-4.1-2025-04-14',
      'model-pricing-row-gpt-4.1-nano-2025-04-14',
    ]);
    expect(screen.getByTestId('model-pricing-bedrock-global.anthropic.claude-opus-5-5')).toBeTruthy();
    expect(screen.queryByTestId('model-pricing-bedrock-claude-opus-5-5')).toBeNull();
  });

  it('prices per 1M tokens, so the cheapest model keeps distinct input and output rates', () => {
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    const nano = screen.getByTestId('model-pricing-row-gpt-4.1-nano-2025-04-14');
    expect(within(nano).getByText(formatCreditsPer1M(0.1 * CREDITS_PER_USD_COST))).toBeTruthy();
    expect(within(nano).getByText(formatCreditsPer1M(0.4 * CREDITS_PER_USD_COST))).toBeTruthy();
    expect(screen.getByText('credits.pricing_per_1m_tokens')).toBeTruthy();
  });
});

describe('CreditAnalyticsTabContent usage by model', () => {
  afterEach(() => {
    hoisted.transactions = [];
  });

  it('labels the pie with display names and one slice per model across backend ids', () => {
    const now = Date.now();
    hoisted.transactions = [
      { type: 'text_generation_usage', credits: -100, createdAt: new Date(now - 3_600_000), model: 'claude-opus-5-5' },
      {
        type: 'text_generation_usage',
        credits: -50,
        createdAt: new Date(now - 3_600_000),
        model: 'global.anthropic.claude-opus-5-5',
      },
    ];
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(pie.data).toEqual([{ id: 'Claude Opus 5.5', label: 'Claude Opus 5.5', value: 150 }]);
  });
});

describe('CreditAnalyticsTabContent days remaining', () => {
  afterEach(() => {
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000 };
    hoisted.transactions = [];
  });

  it('says it is too early instead of projecting from a day-old account', () => {
    const now = Date.now();
    hoisted.currentUser = { id: 'user_1', currentCredits: 9237, createdAt: new Date(now - 6 * 60 * 60 * 1000) };
    hoisted.transactions = [
      { type: 'text_generation_usage', credits: -760, createdAt: new Date(now - 60 * 60 * 1000), model: 'm' },
    ];
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(screen.getByTestId('credit-analytics-days-remaining')).toHaveTextContent('Too early');
  });
});

describe('CreditAnalyticsTabContent video usage', () => {
  afterEach(() => {
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000 };
    hoisted.transactions = [];
    line.series = [];
  });

  it('counts video spend in the burn rate, the usage series and the model pie', () => {
    const now = Date.now();
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000, createdAt: new Date(now - 8 * 86_400_000) };
    hoisted.transactions = [
      { type: 'video_generation_usage', credits: -500, createdAt: new Date(now - 3_600_000), model: 'veo-3' },
    ];
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    // A projection needs a non-zero burn rate, so this stays N/A unless the video row counts.
    expect(screen.getByTestId('credit-analytics-days-remaining')).not.toHaveTextContent(/N\/A|Too early/);
    expect(line.series.find(s => s.id === 'usage')?.data.reduce((sum, point) => sum + point.y, 0)).toBe(500);
    expect(pie.data).toEqual([{ id: 'Veo 3', label: 'Veo 3', value: 500 }]);
  });

  it('adds a video generation line to the all-types chart', () => {
    const now = Date.now();
    hoisted.transactions = [
      { type: 'video_generation_usage', credits: -500, createdAt: new Date(now - 3_600_000), model: 'veo-3' },
    ];
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    const [, viewModeSelect] = screen.getAllByRole('combobox');
    fireEvent.mouseDown(viewModeSelect);
    fireEvent.click(screen.getByText('All Types'));

    expect(line.series.map(series => series.id)).toEqual(['video_generation_usage']);
  });
});

describe('CreditAnalyticsTabContent usage by model list', () => {
  afterEach(() => {
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000 };
    hoisted.transactions = [];
  });

  it('sorts the pie largest-first and lists every model with its value', () => {
    const at = new Date(Date.now() - 3_600_000);
    hoisted.transactions = [
      { type: 'text_generation_usage', credits: -10, createdAt: at, model: 'gpt-4.1-nano-2025-04-14' },
      { type: 'text_generation_usage', credits: -100, createdAt: at, model: 'claude-opus-5-5' },
    ];
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(pie.data).toEqual([
      { id: 'Claude Opus 5.5', label: 'Claude Opus 5.5', value: 100 },
      { id: 'GPT-4.1 Nano', label: 'GPT-4.1 Nano', value: 10 },
    ]);
    const rows = within(screen.getByTestId('credit-analytics-model-list')).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Claude Opus 5.5');
    expect(rows[0]).toHaveTextContent('100');
    expect(rows[1]).toHaveTextContent('GPT-4.1 Nano');
    expect(rows[1]).toHaveTextContent('10');
  });
});

describe('CreditAnalyticsTabContent spend breakdown', () => {
  afterEach(() => {
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000 };
    hoisted.transactions = [];
    dashboard.props = null;
  });

  it('mounts the usage-event breakdown for the signed-in user', async () => {
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(await screen.findByTestId('usage-dashboard')).toBeTruthy();
    expect(dashboard.props).toEqual({ ownerType: CreditHolderType.User, ownerId: 'user_1' });
  });

  it('omits the breakdown when there is no user id', () => {
    hoisted.currentUser = { currentCredits: 1000 };
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('usage-spend-breakdown')).toBeNull();
  });
});
