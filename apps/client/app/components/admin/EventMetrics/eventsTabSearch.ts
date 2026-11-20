// Query and saved view are unused here.
export const EVENTS_SEARCH_KEYS = {
  query: 'eventsQuery',
  view: 'eventsSavedView',
  filters: {
    view: 'eventsView',
    accounts: 'adoptionAccounts',
    client: 'adoptionClient',
    days: 'adoptionDays',
    end: 'adoptionEnd',
    feature: 'adoptionFeature',
  },
} as const;
export const EVENTS_TAB_PARAMS = Object.values(EVENTS_SEARCH_KEYS.filters);
export const EVENTS_VIEW_BY_USER = 'by-user';
