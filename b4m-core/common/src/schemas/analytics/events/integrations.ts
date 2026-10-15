import { IBaseEvent } from '../../../types';

/**
 * The integrations gallery at /integrations (apps/client/app/components/integrations/IntegrationsGallery.tsx).
 * Registered in ANALYTICS_EVENTS (apps/client/server/types/analytics/index.ts), whose families are
 * merged by object spread: the enum KEYS carry an INTEGRATIONS_ prefix so none can overwrite
 * another family's key.
 */
export enum IntegrationsEvents {
  INTEGRATIONS_PAGE_VIEWED = 'Integrations Page Viewed',
  INTEGRATIONS_SEARCH_PERFORMED = 'Integrations Search Performed',
  INTEGRATIONS_FILTER_CHANGED = 'Integrations Filter Changed',
  INTEGRATIONS_CARD_OPENED = 'Integrations Card Opened',
  INTEGRATIONS_CONNECT_CLICKED = 'Integrations Connect Clicked',
  INTEGRATIONS_REQUEST_TOGGLED = 'Integrations Request Toggled',
}

/**
 * Where a visit to /integrations started, carried as the page's `?source=` search param.
 * `direct` covers everything else: a typed URL, a bookmark, a shared link.
 */
export const INTEGRATIONS_PAGE_SOURCES = ['profile_menu', 'profile_tab_link', 'direct'] as const;
export type IntegrationsPageSource = (typeof INTEGRATIONS_PAGE_SOURCES)[number];

export const isIntegrationsPageSource = (value: unknown): value is IntegrationsPageSource =>
  typeof value === 'string' && (INTEGRATIONS_PAGE_SOURCES as readonly string[]).includes(value);

export const INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH = 64;

/** The search query as recorded: trimmed, lowercased and capped, so a pasted paragraph never lands in analytics. */
export const normalizeIntegrationsSearchQuery = (query: string): string =>
  query.trim().toLowerCase().slice(0, INTEGRATIONS_SEARCH_QUERY_MAX_LENGTH).trim();

export type IntegrationsGalleryTab = 'integrations' | 'models';
export type IntegrationsGalleryFilter = 'category' | 'status' | 'kind';

/**
 * Metadata of a settled search. A query holding '@' is most likely an email address typed into
 * the wrong box, so its text is withheld (`redacted`) and only the counts are recorded.
 */
export type IntegrationsSearchMetadata = { resultCount: number; tab: IntegrationsGalleryTab } & (
  { query: string; redacted?: undefined } | { redacted: true; query?: undefined }
);

/** The metadata to record for a settled search; checks the raw text, since normalizing truncates it. */
export const buildIntegrationsSearchMetadata = (
  rawQuery: string,
  resultCount: number,
  tab: IntegrationsGalleryTab
): IntegrationsSearchMetadata =>
  rawQuery.includes('@')
    ? { redacted: true, resultCount, tab }
    : { query: normalizeIntegrationsSearchQuery(rawQuery), resultCount, tab };

interface IIntegrationsPageViewedEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_PAGE_VIEWED;
  // Not `source`: CounterLog reports group every event by `metadata.source` as a CompletionSource
  // (formatUsageBySource), so a page entry point there would show up as a client.
  metadata: {
    entryPoint: IntegrationsPageSource;
  };
}

/**
 * Fired once the query settles, not per keystroke. `query` is normalized by
 * normalizeIntegrationsSearchQuery and absent when `redacted`; `resultCount` is the entries shown
 * for the query on the active tab, under its active filters.
 */
interface IIntegrationsSearchPerformedEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_SEARCH_PERFORMED;
  metadata: IntegrationsSearchMetadata;
}

interface IIntegrationsFilterChangedEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_FILTER_CHANGED;
  metadata: {
    filter: IntegrationsGalleryFilter;
    /** The picked option's value; `all` when the filter was cleared. */
    value: string;
  };
}

interface IIntegrationsCardOpenedEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_CARD_OPENED;
  metadata: {
    integrationId: string;
  };
}

interface IIntegrationsConnectClickedEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_CONNECT_CLICKED;
  metadata: {
    integrationId: string;
  };
}

interface IIntegrationsRequestToggledEvent extends IBaseEvent {
  type: IntegrationsEvents.INTEGRATIONS_REQUEST_TOGGLED;
  metadata: {
    integrationId: string;
    /** What the click asked for: true files a request, false withdraws one. */
    requested: boolean;
  };
}

export type IntegrationsEventPayload =
  | IIntegrationsPageViewedEvent
  | IIntegrationsSearchPerformedEvent
  | IIntegrationsFilterChangedEvent
  | IIntegrationsCardOpenedEvent
  | IIntegrationsConnectClickedEvent
  | IIntegrationsRequestToggledEvent;
