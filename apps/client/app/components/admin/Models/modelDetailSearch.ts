/**
 * The search params of `/admin/models/$` (the model detail page). Pure and React-free, because router.tsx imports
 * it eagerly. Phase 1 ships Overview, Access and Admin log (docs/admin-models-spec.md section 8).
 */

export const MODEL_DETAIL_TABS = ['overview', 'access', 'admin'] as const;

export type ModelDetailTab = (typeof MODEL_DETAIL_TABS)[number];

export const DEFAULT_MODEL_DETAIL_TAB: ModelDetailTab = 'overview';

export const MODEL_DETAIL_TAB_LABELS: Readonly<Record<ModelDetailTab, string>> = {
  overview: 'Overview',
  access: 'Access',
  admin: 'Admin log',
};

export type ModelDetailSearch = { tab?: ModelDetailTab };

export const isModelDetailTab = (value: unknown): value is ModelDetailTab =>
  typeof value === 'string' && (MODEL_DETAIL_TABS as readonly string[]).includes(value);

/** The route's `validateSearch`: the default tab stays out of the URL, and an unknown one is dropped. */
export const parseModelDetailSearch = (search: Record<string, unknown>): ModelDetailSearch => {
  const tab = search.tab;
  return { tab: isModelDetailTab(tab) && tab !== DEFAULT_MODEL_DETAIL_TAB ? tab : undefined };
};
