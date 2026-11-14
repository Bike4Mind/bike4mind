import { ADMIN_MODEL_SORTS, ADMIN_MODEL_VIEWS, type AdminModelSort, type AdminModelView } from '@bike4mind/common';
import { oneOf } from '../adminSearchValues';
import type { AdminListSearchKeys } from '../shared/useAdminListUrlState';

/**
 * The Models tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts (and through
 * it router.tsx's eager import) reads it. Every param carries a `models` prefix, except the Prices section's
 * `model`. Model ids and names are not personal data, so the search box is kept in the URL.
 */

export const MODELS_TAB_SLUG = 'models';

export const MODELS_SECTION_PARAM = 'modelsSection';
export const MODELS_SECTIONS = ['list', 'prices', 'discovery', 'settings'] as const;
export type ModelsSection = (typeof MODELS_SECTIONS)[number];
export const DEFAULT_MODELS_SECTION: ModelsSection = 'list';

export const MODELS_QUERY_PARAM = 'modelsQuery';
export const MODELS_VIEW_PARAM = 'modelsView';
export const MODELS_PROVIDER_PARAM = 'modelsProvider';
export const MODELS_TYPE_PARAM = 'modelsType';
export const MODELS_SOURCE_PARAM = 'modelsSource';
export const MODELS_FOUNDATION_PARAM = 'modelsFoundation';
export const MODELS_SORT_PARAM = 'modelsSort';
export const MODELS_DIR_PARAM = 'modelsDir';
export const MODELS_PAGE_PARAM = 'modelsPage';
export const MODELS_PAGE_SIZE_PARAM = 'modelsPageSize';
/** Prices section: narrows the pricing table to one model. */
export const MODELS_PRICE_MODEL_PARAM = 'model';

/** Keys for useAdminListUrlState; multi-value filters are comma-separated in the URL. */
export const MODELS_LIST_SEARCH_KEYS: AdminListSearchKeys = {
  query: MODELS_QUERY_PARAM,
  view: MODELS_VIEW_PARAM,
  filters: {
    providers: MODELS_PROVIDER_PARAM,
    types: MODELS_TYPE_PARAM,
    sources: MODELS_SOURCE_PARAM,
    foundation: MODELS_FOUNDATION_PARAM,
    sort: MODELS_SORT_PARAM,
    dir: MODELS_DIR_PARAM,
    page: MODELS_PAGE_PARAM,
    pageSize: MODELS_PAGE_SIZE_PARAM,
  },
};

export const MODELS_TAB_PARAMS = [
  MODELS_SECTION_PARAM,
  MODELS_QUERY_PARAM,
  MODELS_VIEW_PARAM,
  MODELS_PROVIDER_PARAM,
  MODELS_TYPE_PARAM,
  MODELS_SOURCE_PARAM,
  MODELS_FOUNDATION_PARAM,
  MODELS_SORT_PARAM,
  MODELS_DIR_PARAM,
  MODELS_PAGE_PARAM,
  MODELS_PAGE_SIZE_PARAM,
  MODELS_PRICE_MODEL_PARAM,
] as const;

export type ModelsSearch = { [MODELS_SECTION_PARAM]?: ModelsSection };

/** Per-key coercion for the route's `validateSearch`; an unknown section becomes undefined. */
export const MODELS_SEARCH_PARSERS: {
  readonly [K in keyof ModelsSearch]-?: (value: unknown) => ModelsSearch[K];
} = {
  [MODELS_SECTION_PARAM]: oneOf(MODELS_SECTIONS),
};

export const parseModelsSection = (value: unknown): ModelsSection =>
  MODELS_SEARCH_PARSERS[MODELS_SECTION_PARAM](value) ?? DEFAULT_MODELS_SECTION;

export const parseModelView = oneOf<AdminModelView>(ADMIN_MODEL_VIEWS);
export const parseModelSort = oneOf<AdminModelSort>(ADMIN_MODEL_SORTS);

/** The search a link into one Models section writes, on top of the console's `tab`. */
export const modelsSectionSearch = (
  section: ModelsSection,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> => ({
  tab: MODELS_TAB_SLUG,
  [MODELS_SECTION_PARAM]: section === DEFAULT_MODELS_SECTION ? undefined : section,
  ...extra,
});
