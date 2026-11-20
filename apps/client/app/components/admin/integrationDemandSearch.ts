export const INTEGRATION_DEMAND_SEARCH_KEYS = {
  query: 'demandQuery',
  view: 'demandView',
  filters: { stage: 'demandStage' },
} as const;
export const INTEGRATION_DEMAND_TAB_PARAMS = [
  INTEGRATION_DEMAND_SEARCH_KEYS.query,
  INTEGRATION_DEMAND_SEARCH_KEYS.view,
  ...Object.values(INTEGRATION_DEMAND_SEARCH_KEYS.filters),
];
