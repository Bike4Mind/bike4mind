/**
 * Data contract for the Spend tab.
 *
 * The exported types below are the shared contract between the Spend tab and the
 * `/api/admin/spend` endpoint, which returns a live `SpendData`-shaped payload.
 * The `spendMockData` fixture is fabricated sample data retained only for tests;
 * do not read anything into the numbers.
 */

/** How a KPI's raw numeric value should be rendered. */
export type SpendKpiFormat = 'currency' | 'currencyPrecise' | 'number' | 'ms' | 'percent';

/** Stable identifier for each KPI card so wiring can map query results by key. */
export type SpendKpiKey =
  | 'estCost'
  | 'requests'
  | 'costPerRequest'
  | 'creditsUsed'
  | 'activeAccounts'
  | 'p50Latency'
  | 'p95Latency'
  | 'errorRate'
  | 'refusalRate';

export interface SpendKpi {
  key: SpendKpiKey;
  label: string;
  /** Raw value for the current period; the component handles formatting. */
  value: number;
  /** Raw value for the immediately prior period, used to compute the delta. */
  priorValue: number;
  format: SpendKpiFormat;
  /**
   * Whether an increase is a good thing. Drives the delta color: cost/latency
   * rising is bad (red), requests/credits rising is good (green).
   */
  higherIsBetter: boolean;
}

export interface SpendByAccountRow {
  accountId: string;
  accountName: string;
  estCost: number;
  requests: number;
  creditsUsed: number;
  costPerRequest: number;
}

export interface CostByModelRow {
  modelId: string;
  modelName: string;
  estCost: number;
  requests: number;
  /** Share of total est. cost across all models, 0..1. */
  share: number;
}

export interface DailyCostPoint {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  cost: number;
}

export interface SpendData {
  /** Human label for the selected period (echoes the ControlPanel range). */
  periodLabel: string;
  /** Human label for the prior comparison period. */
  priorPeriodLabel: string;
  kpis: SpendKpi[];
  byAccount: SpendByAccountRow[];
  byModel: CostByModelRow[];
  dailyCost: DailyCostPoint[];
}

export const spendMockData: SpendData = {
  periodLabel: 'Last 30 days',
  priorPeriodLabel: 'Prior 30 days',
  kpis: [
    {
      key: 'estCost',
      label: 'Est. Cost',
      value: 4218.57,
      priorValue: 3894.12,
      format: 'currency',
      higherIsBetter: false,
    },
    { key: 'requests', label: 'Requests', value: 128940, priorValue: 121305, format: 'number', higherIsBetter: true },
    {
      key: 'costPerRequest',
      label: 'Cost / Req',
      value: 0.0327,
      priorValue: 0.0321,
      format: 'currencyPrecise',
      higherIsBetter: false,
    },
    {
      key: 'creditsUsed',
      label: 'Credits Used',
      value: 421857,
      priorValue: 389412,
      format: 'number',
      higherIsBetter: true,
    },
    {
      key: 'activeAccounts',
      label: 'Active Accounts',
      value: 47,
      priorValue: 43,
      format: 'number',
      higherIsBetter: true,
    },
    { key: 'p50Latency', label: 'p50 Latency', value: 812, priorValue: 845, format: 'ms', higherIsBetter: false },
    { key: 'p95Latency', label: 'p95 Latency', value: 3140, priorValue: 2980, format: 'ms', higherIsBetter: false },
    {
      key: 'errorRate',
      label: 'Error Rate',
      value: 0.021,
      priorValue: 0.028,
      format: 'percent',
      higherIsBetter: false,
    },
    {
      key: 'refusalRate',
      label: 'Refusal Rate',
      value: 0.009,
      priorValue: 0.007,
      format: 'percent',
      higherIsBetter: false,
    },
  ],
  byAccount: [
    {
      accountId: 'acct_01',
      accountName: 'Northwind Labs',
      estCost: 1284.42,
      requests: 38210,
      creditsUsed: 128442,
      costPerRequest: 0.0336,
    },
    {
      accountId: 'acct_02',
      accountName: 'Contoso Research',
      estCost: 902.15,
      requests: 27640,
      creditsUsed: 90215,
      costPerRequest: 0.0326,
    },
    {
      accountId: 'acct_03',
      accountName: 'Fabrikam AI',
      estCost: 671.88,
      requests: 21050,
      creditsUsed: 67188,
      costPerRequest: 0.0319,
    },
    {
      accountId: 'acct_04',
      accountName: 'Adventure Works',
      estCost: 544.33,
      requests: 16720,
      creditsUsed: 54433,
      costPerRequest: 0.0326,
    },
    {
      accountId: 'acct_05',
      accountName: 'Tailspin Toys',
      estCost: 398.7,
      requests: 12480,
      creditsUsed: 39870,
      costPerRequest: 0.0319,
    },
    {
      accountId: 'acct_06',
      accountName: 'Wingtip Media',
      estCost: 264.09,
      requests: 8140,
      creditsUsed: 26409,
      costPerRequest: 0.0324,
    },
    {
      accountId: 'acct_07',
      accountName: 'Proseware Inc',
      estCost: 153.0,
      requests: 4700,
      creditsUsed: 15300,
      costPerRequest: 0.0326,
    },
  ],
  byModel: [
    { modelId: 'claude-opus-5', modelName: 'Claude Opus 5', estCost: 1687.43, requests: 24180, share: 0.4 },
    { modelId: 'claude-sonnet-5', modelName: 'Claude Sonnet 5', estCost: 1096.83, requests: 41260, share: 0.26 },
    { modelId: 'gpt-4o', modelName: 'GPT-4o', estCost: 632.79, requests: 28510, share: 0.15 },
    { modelId: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5', estCost: 464.04, requests: 22090, share: 0.11 },
    { modelId: 'gemini-2-flash', modelName: 'Gemini 2 Flash', estCost: 337.48, requests: 12900, share: 0.08 },
  ],
  dailyCost: [
    { date: '2026-07-09', cost: 118.42 },
    { date: '2026-07-10', cost: 131.07 },
    { date: '2026-07-11', cost: 96.55 },
    { date: '2026-07-12', cost: 88.31 },
    { date: '2026-07-13', cost: 142.9 },
    { date: '2026-07-14', cost: 155.24 },
    { date: '2026-07-15', cost: 149.68 },
    { date: '2026-07-16', cost: 137.11 },
    { date: '2026-07-17', cost: 161.05 },
    { date: '2026-07-18', cost: 102.77 },
    { date: '2026-07-19', cost: 94.6 },
    { date: '2026-07-20', cost: 168.33 },
    { date: '2026-07-21', cost: 174.5 },
    { date: '2026-07-22', cost: 159.82 },
    { date: '2026-07-23', cost: 148.19 },
    { date: '2026-07-24', cost: 172.44 },
    { date: '2026-07-25', cost: 111.28 },
    { date: '2026-07-26', cost: 99.4 },
    { date: '2026-07-27', cost: 181.66 },
    { date: '2026-07-28', cost: 190.02 },
    { date: '2026-07-29', cost: 165.75 },
    { date: '2026-07-30', cost: 158.31 },
    { date: '2026-07-31', cost: 176.9 },
    { date: '2026-08-01', cost: 120.14 },
    { date: '2026-08-02', cost: 108.87 },
    { date: '2026-08-03', cost: 193.55 },
    { date: '2026-08-04', cost: 201.38 },
    { date: '2026-08-05', cost: 178.62 },
    { date: '2026-08-06', cost: 169.44 },
    { date: '2026-08-07', cost: 184.05 },
  ],
};
