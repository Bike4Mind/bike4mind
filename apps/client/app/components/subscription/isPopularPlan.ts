const POPULAR_PLAN_NAME = 'Professional';

/** A "Most Popular" badge only means something when plans are shown side by side. */
export const isPopularPlan = (planName: string, renderedPlanCount: number): boolean =>
  renderedPlanCount > 1 && planName === POPULAR_PLAN_NAME;
