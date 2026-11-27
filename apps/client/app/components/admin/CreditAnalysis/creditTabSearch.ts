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
export type CreditTabSearch = { [CREDIT_TAB_PARAM]?: UrlCreditTab };

export const parseCreditTab = oneOf(URL_CREDIT_TABS);

export const CREDIT_TAB_SEARCH_PARSERS = { [CREDIT_TAB_PARAM]: parseCreditTab } as const;

export const creditTabSearchValue = (tab: CreditAnalysisTab): UrlCreditTab | undefined => parseCreditTab(tab);
