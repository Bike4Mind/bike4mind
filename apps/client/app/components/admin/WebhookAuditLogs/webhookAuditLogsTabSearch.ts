import { WebhookAuditStatus, type WebhookSourceType } from '@bike4mind/common';
import { oneOf } from '../adminSearchValues';

/**
 * The Webhook Audit Logs tab's `/admin` search params and their coercion. Pure and React-free:
 * adminTabParams.ts (and through it router.tsx's eager import) reads it. Every param carries a
 * `webhook` prefix because other tabs already own the bare names (Audit Log's `source`), and the
 * registry gives every param exactly one owner. The repository filter is an `owner/repo` name, not
 * a search over people, so it may go in a shared URL.
 */

export const WEBHOOK_RANGE_PARAM = 'webhookRange';
export const WEBHOOK_REPO_PARAM = 'webhookRepo';
export const WEBHOOK_EVENT_PARAM = 'webhookEvent';
export const WEBHOOK_STATUS_PARAM = 'webhookStatus';
export const WEBHOOK_SOURCE_PARAM = 'webhookSource';
/** The delivery open in the detail drawer. */
export const WEBHOOK_DELIVERY_ID_PARAM = 'webhookDeliveryId';

export const WEBHOOK_AUDIT_LOGS_TAB_PARAMS = [
  WEBHOOK_RANGE_PARAM,
  WEBHOOK_REPO_PARAM,
  WEBHOOK_EVENT_PARAM,
  WEBHOOK_STATUS_PARAM,
  WEBHOOK_SOURCE_PARAM,
  WEBHOOK_DELIVERY_ID_PARAM,
] as const;

// getDateRangePreset (hooks/data/webhookAuditLogs.ts) takes this union, so a preset it cannot
// compute is a compile error there.
export type WebhookDatePreset = '24h' | '7d' | '30d' | '90d';

// The filters' menus, in menu order. Each Record lists every member of its union, and the URL
// parsers below accept exactly these keys, so a menu option can never be one the URL drops.
export const WEBHOOK_DATE_PRESET_LABELS: Readonly<Record<WebhookDatePreset, string>> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

export const WEBHOOK_STATUS_LABELS: Readonly<Record<WebhookAuditStatus, string>> = {
  [WebhookAuditStatus.Completed]: 'Completed',
  [WebhookAuditStatus.Failed]: 'Failed',
  [WebhookAuditStatus.Processing]: 'Processing',
  [WebhookAuditStatus.Received]: 'Received',
};

export const WEBHOOK_SOURCE_LABELS: Readonly<Record<WebhookSourceType, string>> = {
  org: 'Org',
  user: 'User',
};

const keysOf = <K extends string>(labels: Readonly<Record<K, string>>): K[] => Object.keys(labels) as K[];

export const WEBHOOK_DATE_PRESETS = keysOf(WEBHOOK_DATE_PRESET_LABELS);
export const WEBHOOK_STATUSES = keysOf(WEBHOOK_STATUS_LABELS);
export const WEBHOOK_SOURCE_TYPES = keysOf(WEBHOOK_SOURCE_LABELS);

/** The event types the filter offers, in menu order. */
export const WEBHOOK_EVENT_OPTIONS = [
  'ping',
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'issues',
  'issue_comment',
  'workflow_run',
  'check_run',
  'check_suite',
] as const;
export type WebhookEventOption = (typeof WEBHOOK_EVENT_OPTIONS)[number];

// GitHub caps an owner at 39 characters and a repo name at 100.
const MAX_REPO_LENGTH = 140;
// The id is interpolated into `/api/admin/webhook-logs/<id>`; GitHub sends a GUID, so a link may only
// carry id-shaped characters, never a `/` or `.` that could walk the path.
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type WebhookAuditLogsSearch = {
  [WEBHOOK_RANGE_PARAM]?: WebhookDatePreset;
  [WEBHOOK_REPO_PARAM]?: string;
  [WEBHOOK_EVENT_PARAM]?: WebhookEventOption;
  [WEBHOOK_STATUS_PARAM]?: WebhookAuditStatus;
  [WEBHOOK_SOURCE_PARAM]?: WebhookSourceType;
  [WEBHOOK_DELIVERY_ID_PARAM]?: string;
};

export type WebhookAuditLogsView = {
  datePreset: WebhookDatePreset;
  /** Empty is every repository. */
  repository: string;
  event: WebhookEventOption | null;
  status: WebhookAuditStatus | null;
  sourceType: WebhookSourceType | null;
};

export const DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW: WebhookAuditLogsView = {
  datePreset: '7d',
  repository: '',
  event: null,
  status: null,
  sourceType: null,
};

const parseRepo = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const repo = value.trim();
  return repo !== '' && repo.length <= MAX_REPO_LENGTH ? repo : undefined;
};

const parseDeliveryId = (value: unknown): string | undefined =>
  typeof value === 'string' && DELIVERY_ID_PATTERN.test(value) ? value : undefined;

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS: {
  readonly [K in keyof WebhookAuditLogsSearch]-?: (value: unknown) => WebhookAuditLogsSearch[K];
} = {
  [WEBHOOK_RANGE_PARAM]: oneOf(WEBHOOK_DATE_PRESETS),
  [WEBHOOK_REPO_PARAM]: parseRepo,
  [WEBHOOK_EVENT_PARAM]: oneOf(WEBHOOK_EVENT_OPTIONS),
  [WEBHOOK_STATUS_PARAM]: oneOf(WEBHOOK_STATUSES),
  [WEBHOOK_SOURCE_PARAM]: oneOf(WEBHOOK_SOURCE_TYPES),
  [WEBHOOK_DELIVERY_ID_PARAM]: parseDeliveryId,
};

const parsers = WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS;

/** The filters a URL describes; a missing or invalid param means its default. */
export function webhookAuditLogsViewFromSearch(search: Record<string, unknown>): WebhookAuditLogsView {
  return {
    datePreset: parsers[WEBHOOK_RANGE_PARAM](search[WEBHOOK_RANGE_PARAM]) ?? DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW.datePreset,
    repository: parsers[WEBHOOK_REPO_PARAM](search[WEBHOOK_REPO_PARAM]) ?? DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW.repository,
    event: parsers[WEBHOOK_EVENT_PARAM](search[WEBHOOK_EVENT_PARAM]) ?? null,
    status: parsers[WEBHOOK_STATUS_PARAM](search[WEBHOOK_STATUS_PARAM]) ?? null,
    sourceType: parsers[WEBHOOK_SOURCE_PARAM](search[WEBHOOK_SOURCE_PARAM]) ?? null,
  };
}

/**
 * The filter params to write for `view`. Every key is present, and a default is set to undefined so
 * it is removed from the URL: a bare `?tab=webhook-audit-logs` is the default view.
 */
export function webhookAuditLogsViewToSearch(view: WebhookAuditLogsView): {
  [K in Exclude<keyof WebhookAuditLogsSearch, typeof WEBHOOK_DELIVERY_ID_PARAM>]: WebhookAuditLogsSearch[K];
} {
  return {
    [WEBHOOK_RANGE_PARAM]:
      view.datePreset === DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW.datePreset
        ? undefined
        : parsers[WEBHOOK_RANGE_PARAM](view.datePreset),
    [WEBHOOK_REPO_PARAM]: parsers[WEBHOOK_REPO_PARAM](view.repository),
    [WEBHOOK_EVENT_PARAM]: parsers[WEBHOOK_EVENT_PARAM](view.event),
    [WEBHOOK_STATUS_PARAM]: parsers[WEBHOOK_STATUS_PARAM](view.status),
    [WEBHOOK_SOURCE_PARAM]: parsers[WEBHOOK_SOURCE_PARAM](view.sourceType),
  };
}
