import { describe, expect, it } from 'vitest';
import {
  displayedBaseState,
  displayedState,
  overallImpactFromComponents,
  stateToVendorIndicator,
  vendorIndicatorToState,
  worstState,
} from './stateOrder';

describe('stateOrder', () => {
  it('worst picks the most severe known state', () => {
    expect(worstState(['operational', 'degraded', 'partial_outage'])).toBe('partial_outage');
    expect(worstState(['major_outage', 'degraded'])).toBe('major_outage');
  });

  it('unknown yields to any known state and an empty list is unknown', () => {
    expect(worstState(['unknown', 'operational'])).toBe('operational');
    expect(worstState(['unknown', 'unknown'])).toBe('unknown');
    expect(worstState([])).toBe('unknown');
    expect(worstState([null, undefined])).toBe('unknown');
  });

  it('base state: pin wins, then suppression, then automatic', () => {
    expect(displayedBaseState({ automatic: 'major_outage', pin: 'degraded', suppressed: true })).toBe('degraded');
    expect(displayedBaseState({ automatic: 'major_outage', suppressed: true })).toBe('operational');
    expect(displayedBaseState({ automatic: 'major_outage' })).toBe('major_outage');
  });

  it('an incident is a floor: it never masks a worse base state', () => {
    expect(displayedState('major_outage', ['degraded'])).toBe('major_outage');
    expect(displayedState('operational', ['degraded'])).toBe('degraded');
    expect(displayedState('unknown', ['degraded'])).toBe('degraded');
    expect(displayedState('operational', [])).toBe('operational');
  });

  it('overall impact defaults from the worst component impact', () => {
    expect(overallImpactFromComponents([])).toBe('none');
    expect(overallImpactFromComponents(['degraded'])).toBe('minor');
    expect(overallImpactFromComponents(['degraded', 'partial_outage'])).toBe('major');
    expect(overallImpactFromComponents(['major_outage', 'degraded'])).toBe('critical');
  });

  it('maps vendor indicators both ways', () => {
    expect(vendorIndicatorToState('none')).toBe('operational');
    expect(vendorIndicatorToState('minor')).toBe('degraded');
    expect(vendorIndicatorToState('major')).toBe('partial_outage');
    expect(vendorIndicatorToState('critical')).toBe('major_outage');
    expect(vendorIndicatorToState('unknown')).toBe('unknown');
    expect(vendorIndicatorToState(null)).toBe('unknown');
    expect(stateToVendorIndicator('partial_outage')).toBe('major');
    expect(stateToVendorIndicator('unknown')).toBe('unknown');
  });
});
