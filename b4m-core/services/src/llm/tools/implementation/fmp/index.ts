import { ToolDefinition, ToolContext } from '../../base/types';
import { GetEffectiveApiKeyAdapters, getFmpApiKey } from '../../../../apiKeyService';
import {
  getStockQuote,
  searchStocks,
  getCompanyProfile,
  getHistoricalPrices,
  getIncomeStatement,
  getBalanceSheet,
} from './fmpService';

interface FmpToolParams {
  action: 'quote' | 'search' | 'profile' | 'history' | 'income_statement' | 'balance_sheet';
  symbol?: string;
  query?: string;
  from?: string;
  to?: string;
  period?: 'annual' | 'quarter';
}

const NOT_CONFIGURED_MSG =
  'Financial Modeling Prep is not configured. Please contact your administrator to set up the FmpApiKey in admin settings.';

async function executeFmpAction(adapters: GetEffectiveApiKeyAdapters, params: FmpToolParams): Promise<string> {
  const apiKey = await getFmpApiKey(adapters);
  if (!apiKey) return NOT_CONFIGURED_MSG;

  const { action } = params;

  switch (action) {
    case 'quote': {
      if (!params.symbol) return 'Error: symbol is required for quote action.';
      const quote = await getStockQuote(apiKey, params.symbol);
      if (!quote) return `No quote data found for symbol "${params.symbol}". Verify the ticker is correct.`;
      return JSON.stringify(quote, null, 2);
    }

    case 'search': {
      if (!params.query) return 'Error: query is required for search action.';
      const results = await searchStocks(apiKey, params.query);
      if (results.length === 0) return `No results found for "${params.query}".`;
      return JSON.stringify(results, null, 2);
    }

    case 'profile': {
      if (!params.symbol) return 'Error: symbol is required for profile action.';
      const profile = await getCompanyProfile(apiKey, params.symbol);
      if (!profile) return `No company profile found for symbol "${params.symbol}".`;
      return JSON.stringify(profile, null, 2);
    }

    case 'history': {
      if (!params.symbol) return 'Error: symbol is required for history action.';
      const prices = await getHistoricalPrices(apiKey, params.symbol, params.from, params.to);
      if (prices.length === 0) return `No historical prices found for "${params.symbol}".`;
      return JSON.stringify(prices, null, 2);
    }

    case 'income_statement': {
      if (!params.symbol) return 'Error: symbol is required for income_statement action.';
      const statements = await getIncomeStatement(apiKey, params.symbol, params.period);
      if (statements.length === 0) return `No income statements found for "${params.symbol}".`;
      return JSON.stringify(statements, null, 2);
    }

    case 'balance_sheet': {
      if (!params.symbol) return 'Error: symbol is required for balance_sheet action.';
      const sheets = await getBalanceSheet(apiKey, params.symbol, params.period);
      if (sheets.length === 0) return `No balance sheet data found for "${params.symbol}".`;
      return JSON.stringify(sheets, null, 2);
    }

    default:
      return `Unknown action "${action}". Valid actions: quote, search, profile, history, income_statement, balance_sheet.`;
  }
}

export const fmpTool: ToolDefinition = {
  name: 'fmp_financial_data',
  implementation: (context: ToolContext) => ({
    toolFn: async value => {
      const params = value as FmpToolParams;
      return executeFmpAction({ db: context.db }, params);
    },
    toolSchema: {
      name: 'fmp_financial_data',
      description: `Query Financial Modeling Prep for real-time stock market and financial data.

USE FOR:
- Stock quotes: Current price, change, volume, market cap, P/E ratio (action=quote)
- Ticker search: Find stock symbols by company name (action=search)
- Company profiles: Industry, sector, CEO, description, employees (action=profile)
- Price history: Daily OHLCV data for charting and analysis (action=history)
- Income statements: Revenue, net income, EPS — annual or quarterly (action=income_statement)
- Balance sheets: Assets, liabilities, equity — annual or quarterly (action=balance_sheet)

DO NOT USE FOR:
- Cryptocurrency prices (FMP focuses on equities)
- Real-time intraday tick data
- Options or futures data
- General financial advice or predictions`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['quote', 'search', 'profile', 'history', 'income_statement', 'balance_sheet'],
            description: 'The type of financial data to retrieve',
          },
          symbol: {
            type: 'string',
            description: 'Stock ticker symbol (e.g., AAPL, MSFT, GOOGL). Required for all actions except search.',
          },
          query: {
            type: 'string',
            description: 'Search query to find stock tickers by company name. Required for action=search.',
          },
          from: {
            type: 'string',
            description: 'Start date in YYYY-MM-DD format (for action=history). Defaults to 1 year ago.',
          },
          to: {
            type: 'string',
            description: 'End date in YYYY-MM-DD format (for action=history). Defaults to today.',
          },
          period: {
            type: 'string',
            enum: ['annual', 'quarter'],
            description: 'Reporting period for financial statements. Defaults to annual.',
          },
        },
        required: ['action'],
      },
    },
  }),
};
