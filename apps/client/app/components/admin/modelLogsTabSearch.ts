import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';
import { oneOf, parsePage, toNumber } from './adminSearchValues';
import { DEFAULT_PRESET_DAYS, getPresetRange } from './EventMetrics/UserActivity/dateRange';

/**
 * The Model Logs tab's `/admin` search params and their coercion. Pure and React-free:
 * adminTabParams.ts (and through it router.tsx's eager import) reads it. The free-text search box is
 * deliberately absent - it matches prompt text, and these URLs get shared and copied into login
 * redirects. Every param carries a `modelLogs` prefix because other tabs already own the bare names
 * (Users' `page`/`limit`, Audit Log's `from`/`to`).
 */

export const MODEL_LOGS_PAGE_PARAM = 'modelLogsPage';
export const MODEL_LOGS_LIMIT_PARAM = 'modelLogsLimit';
export const MODEL_LOGS_FROM_PARAM = 'modelLogsFrom';
export const MODEL_LOGS_TO_PARAM = 'modelLogsTo';
export const MODEL_LOGS_MODEL_PARAM = 'modelLogsModel';

export const MODEL_LOGS_TAB_PARAMS = [
  MODEL_LOGS_PAGE_PARAM,
  MODEL_LOGS_LIMIT_PARAM,
  MODEL_LOGS_FROM_PARAM,
  MODEL_LOGS_TO_PARAM,
  MODEL_LOGS_MODEL_PARAM,
] as const;

export const MODEL_LOGS_PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type ModelLogsPageSize = (typeof MODEL_LOGS_PAGE_SIZE_OPTIONS)[number];

/** The model filter's options, in menu order; no param is every model. */
export const MODEL_LOGS_MODEL_OPTIONS = [
  { value: 'gpt-4', label: 'GPT-4' },
  { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  { value: 'claude-3-opus', label: 'Claude 3 Opus' },
  { value: 'claude-3-sonnet', label: 'Claude 3 Sonnet' },
] as const;
export type ModelLogsModel = (typeof MODEL_LOGS_MODEL_OPTIONS)[number]['value'];
const MODEL_VALUES = MODEL_LOGS_MODEL_OPTIONS.map(option => option.value);

// The date inputs' and the model-logs API's format.
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ModelLogsSearch = {
  [MODEL_LOGS_PAGE_PARAM]?: number;
  [MODEL_LOGS_LIMIT_PARAM]?: ModelLogsPageSize;
  [MODEL_LOGS_FROM_PARAM]?: string;
  [MODEL_LOGS_TO_PARAM]?: string;
  [MODEL_LOGS_MODEL_PARAM]?: ModelLogsModel;
};

export type ModelLogsView = {
  page: number;
  limit: number;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  endDate: string;
  /** Undefined is every model. */
  model: ModelLogsModel | undefined;
};

/**
 * The range a URL without dates means, relative to today. It is the date filter's default preset,
 * so that preset shows as selected when the tab opens.
 */
export const defaultModelLogsDateRange = (): Pick<ModelLogsView, 'startDate' | 'endDate'> =>
  getPresetRange(DEFAULT_PRESET_DAYS);

export const defaultModelLogsView = (): ModelLogsView => ({
  page: 1,
  limit: MODEL_LOGS_PAGE_SIZE_OPTIONS[0],
  ...defaultModelLogsDateRange(),
  model: undefined,
});

// A calendar date only: the round trip rejects `2026-02-30`, which Date would roll into March.
const parseDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value) ? value : undefined;
};

const parseModelLogsPage = (value: unknown): number | undefined => {
  const page = parsePage(value);
  return page !== undefined && page <= MODEL_LOGS_MAX_PAGE ? page : undefined;
};

const parseLimit = (value: unknown): ModelLogsPageSize | undefined => {
  const limit = toNumber(value);
  return MODEL_LOGS_PAGE_SIZE_OPTIONS.find(option => option === limit);
};

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const MODEL_LOGS_SEARCH_PARSERS: {
  readonly [K in keyof ModelLogsSearch]-?: (value: unknown) => ModelLogsSearch[K];
} = {
  [MODEL_LOGS_PAGE_PARAM]: parseModelLogsPage,
  [MODEL_LOGS_LIMIT_PARAM]: parseLimit,
  [MODEL_LOGS_FROM_PARAM]: parseDate,
  [MODEL_LOGS_TO_PARAM]: parseDate,
  [MODEL_LOGS_MODEL_PARAM]: oneOf(MODEL_VALUES),
};

/**
 * The view a URL describes; a missing or invalid param means its default. A missing date falls back
 * to its end of the default range. A range that ends before it starts is kept as written: the date
 * inputs write on every keystroke, so a partly typed year is briefly inverted and must survive.
 */
export function modelLogsViewFromSearch(search: Record<string, unknown>): ModelLogsView {
  const defaults = defaultModelLogsView();
  const startDate = parseDate(search[MODEL_LOGS_FROM_PARAM]) ?? defaults.startDate;
  const endDate = parseDate(search[MODEL_LOGS_TO_PARAM]) ?? defaults.endDate;
  return {
    page: parseModelLogsPage(search[MODEL_LOGS_PAGE_PARAM]) ?? defaults.page,
    limit: parseLimit(search[MODEL_LOGS_LIMIT_PARAM]) ?? defaults.limit,
    startDate,
    endDate,
    model: MODEL_LOGS_SEARCH_PARSERS[MODEL_LOGS_MODEL_PARAM](search[MODEL_LOGS_MODEL_PARAM]),
  };
}

/**
 * The params to write for `view`. Every key is present, and a default is set to undefined so it is
 * removed from the URL. The dates are written as a pair, and only when the range differs from the
 * default: a bare `?tab=model-logs` keeps meaning "the last week", whatever day the link is opened.
 */
export function modelLogsViewToSearch(view: ModelLogsView): {
  [K in keyof ModelLogsSearch]: ModelLogsSearch[K];
} {
  const defaults = defaultModelLogsView();
  const isDefaultRange = view.startDate === defaults.startDate && view.endDate === defaults.endDate;
  return {
    [MODEL_LOGS_PAGE_PARAM]: view.page === defaults.page ? undefined : parseModelLogsPage(view.page),
    [MODEL_LOGS_LIMIT_PARAM]: view.limit === defaults.limit ? undefined : parseLimit(view.limit),
    [MODEL_LOGS_FROM_PARAM]: isDefaultRange ? undefined : parseDate(view.startDate),
    [MODEL_LOGS_TO_PARAM]: isDefaultRange ? undefined : parseDate(view.endDate),
    [MODEL_LOGS_MODEL_PARAM]: MODEL_LOGS_SEARCH_PARSERS[MODEL_LOGS_MODEL_PARAM](view.model),
  };
}
