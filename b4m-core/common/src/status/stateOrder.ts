export const COMPONENT_STATES = ['operational', 'degraded', 'partial_outage', 'major_outage'] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** `unknown` sits outside the severity order and yields to any known state. */
export type DisplayState = ComponentState | 'unknown';
export const DISPLAY_STATES = [...COMPONENT_STATES, 'unknown'] as const;

export const COMPONENT_IMPACTS = ['degraded', 'partial_outage', 'major_outage'] as const;
export type ComponentImpact = (typeof COMPONENT_IMPACTS)[number];

export const OVERALL_IMPACTS = ['none', 'minor', 'major', 'critical'] as const;
export type OverallImpact = (typeof OVERALL_IMPACTS)[number];

export const VENDOR_INDICATORS = ['none', 'minor', 'major', 'critical', 'unknown'] as const;
export type VendorIndicator = (typeof VENDOR_INDICATORS)[number];

export const STATE_SEVERITY: Record<ComponentState, number> = {
  operational: 0,
  degraded: 1,
  partial_outage: 2,
  major_outage: 3,
};

const OVERALL_SEVERITY: Record<OverallImpact, number> = { none: 0, minor: 1, major: 2, critical: 3 };

const OVERALL_IMPACT_STATE: Record<OverallImpact, ComponentState> = {
  none: 'operational',
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
};

export function overallImpactToState(impact: OverallImpact): ComponentState {
  return OVERALL_IMPACT_STATE[impact];
}

/**
 * Worst state over the given active incident-kind entries that list no component on the page, or null
 * when there is none: no row can show an incident that touches no listed component.
 */
export function uncoveredIncidentState(
  incidents: readonly { kind: string; impact: OverallImpact; components: readonly { slug: string }[] }[],
  pageSlugs: ReadonlySet<string>
): DisplayState | null {
  const states = incidents
    .filter(incident => incident.kind === 'incident' && !incident.components.some(c => pageSlugs.has(c.slug)))
    .map(incident => overallImpactToState(incident.impact));
  return states.length === 0 ? null : worstState(states);
}

export function isComponentState(value: unknown): value is ComponentState {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATE_SEVERITY, value);
}

/** Worst of the given states; an empty list, or only unknowns, is `unknown`. */
export function worstState(states: readonly (DisplayState | null | undefined)[]): DisplayState {
  let worst: ComponentState | null = null;
  for (const state of states) {
    if (!isComponentState(state)) continue;
    if (worst === null || STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state;
  }
  return worst ?? 'unknown';
}

export function worstImpact(impacts: readonly (ComponentImpact | null | undefined)[]): ComponentImpact | null {
  let worst: ComponentImpact | null = null;
  for (const impact of impacts) {
    if (!impact) continue;
    if (worst === null || STATE_SEVERITY[impact] > STATE_SEVERITY[worst]) worst = impact;
  }
  return worst;
}

export function impactSeverity(impact: OverallImpact): number {
  return OVERALL_SEVERITY[impact];
}

/** Overall incident impact defaulted from the worst component impact. */
export function overallImpactFromComponents(impacts: readonly ComponentImpact[]): OverallImpact {
  const worst = worstImpact(impacts);
  if (worst === 'major_outage') return 'critical';
  if (worst === 'partial_outage') return 'major';
  if (worst === 'degraded') return 'minor';
  return 'none';
}

export function vendorIndicatorToState(indicator: VendorIndicator | null | undefined): DisplayState {
  switch (indicator) {
    case 'none':
      return 'operational';
    case 'minor':
      return 'degraded';
    case 'major':
      return 'partial_outage';
    case 'critical':
      return 'major_outage';
    default:
      return 'unknown';
  }
}

export function stateToVendorIndicator(state: DisplayState): VendorIndicator {
  switch (state) {
    case 'operational':
      return 'none';
    case 'degraded':
      return 'minor';
    case 'partial_outage':
      return 'major';
    case 'major_outage':
      return 'critical';
    default:
      return 'unknown';
  }
}

/** baseState(C) = active pin state if any, else (suppressed ? operational : automatic state). */
export function displayedBaseState(input: {
  automatic: DisplayState;
  pin?: ComponentState | null;
  suppressed?: boolean;
}): DisplayState {
  if (input.pin) return input.pin;
  return input.suppressed ? 'operational' : input.automatic;
}

/** state(C) = worst(baseState(C), impacts of active published incident-kind incidents listing C). */
export function displayedState(base: DisplayState, activeIncidentImpacts: readonly ComponentImpact[]): DisplayState {
  if (activeIncidentImpacts.length === 0) return base;
  return worstState([base, ...activeIncidentImpacts]);
}
