export {
  VIEW_REGISTRY,
  FEATURE_PATH_PREFIXES,
  getCurrentPathFromContext,
  getViewById,
  getFilteredViews,
  getViewSummaryForLLM,
  isNavigableFeaturePath,
  resolveNavigationIntents,
} from './viewRegistry';

export type { NavigableView, NavigationIntent, NavigationType, ViewSection } from './viewRegistry';
