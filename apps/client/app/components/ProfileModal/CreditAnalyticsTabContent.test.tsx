import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CREDITS_PER_USD_COST, ModelBackend, type ModelInfo } from '@bike4mind/common';
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

const hoisted = vi.hoisted(() => ({
  currentUser: { id: 'user_1', currentCredits: 1000 } as Record<string, unknown> | null,
  transactions: [] as Array<Record<string, unknown>>,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@nivo/line', () => ({ ResponsiveLine: () => null }));
const pie = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('@nivo/pie', () => ({
  ResponsivePie: ({ data }: { data: unknown[] }) => {
    pie.data = data;
    return null;
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
    isLoading: false,
    isModelsError: false,
  }),
}));
// The spend breakdown owns its own /api/usage query; stub it so these tests cover only that the
// Usage tab mounts it, not what it fetches.
vi.mock('@client/app/components/admin/CreditAnalysis/components/UsageDashboard', () => ({
  UsageDashboard: () => <div data-testid="usage-dashboard" />,
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

describe('CreditAnalyticsTabContent spend breakdown', () => {
  afterEach(() => {
    hoisted.currentUser = { id: 'user_1', currentCredits: 1000 };
  });

  // The per-key / per-feature / per-source cut moved here from the API Keys tab, which is now
  // keys-only. Mounting it on this tab is what keeps "one usage view" from dropping the cut.
  it('mounts the personal spend breakdown under a heading', () => {
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(screen.getByText('Spend breakdown')).toBeTruthy();
    expect(screen.getByTestId('usage-dashboard')).toBeTruthy();
  });

  it('omits the spend breakdown when no user is signed in', () => {
    hoisted.currentUser = null;
    render(<CreditAnalyticsTabContent />, { wrapper: TestWrapper });

    expect(screen.queryByTestId('usage-dashboard')).toBeNull();
  });
});
