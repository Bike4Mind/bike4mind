import { oneOf } from '../adminSearchValues';

/**
 * The Credit analytics inner tab in `/admin` search params. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it.
 */
export const CREDIT_TAB_PARAM = 'creditTab';

export const CREDIT_ANALYSIS_TABS = [
  'users',
  'margins',
  'org-usage',
  'api-usage',
  'side-apps',
  'elevenlabs',
  'ledger',
  'adjustments',
  'economy',
] as const;
export type CreditAnalysisTab = (typeof CREDIT_ANALYSIS_TABS)[number];

// Economy has its own `creditView` param, and users is the default; neither belongs in the URL.
const URL_CREDIT_TABS = CREDIT_ANALYSIS_TABS.filter(tab => tab !== 'economy' && tab !== 'users');
type UrlCreditTab = (typeof URL_CREDIT_TABS)[number];

/** The Side apps client whose drill-down is open; only meaningful with `creditTab=side-apps`. */
export const SIDE_APP_PARAM = 'sideApp';
export type CreditTabSearch = { [CREDIT_TAB_PARAM]?: UrlCreditTab; [SIDE_APP_PARAM]?: string };

export const parseCreditTab = oneOf(URL_CREDIT_TABS);

// The id goes into an API path and a Slack link, so only a bounded, URL-safe client id may come in.
export const parseSideApp = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : undefined;

export const CREDIT_TAB_SEARCH_PARSERS = {
  [CREDIT_TAB_PARAM]: parseCreditTab,
  [SIDE_APP_PARAM]: parseSideApp,
} as const;

export const creditTabSearchValue = (tab: CreditAnalysisTab): UrlCreditTab | undefined => parseCreditTab(tab);
