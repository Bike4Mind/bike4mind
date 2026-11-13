import { describe, expect, it } from 'vitest';
import { cohortsOf, type CohortSignals } from './cohorts';

const signals = (overrides: Partial<CohortSignals> = {}): CohortSignals => ({
  userAgent: null,
  deviceTypes: [],
  sharedSignupIp: false,
  apiAgentUsage: false,
  ...overrides,
});

describe('cohortsOf', () => {
  it('has no cohort without signals', () => {
    expect(cohortsOf(signals())).toEqual([]);
  });

  it('recognises a mobile user agent or a mobile or tablet login', () => {
    expect(cohortsOf(signals({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }))).toEqual(['mobile']);
    expect(cohortsOf(signals({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0)' }))).toEqual(['mobile']);
    expect(cohortsOf(signals({ deviceTypes: ['Desktop', 'Mobile'] }))).toEqual(['mobile']);
    expect(cohortsOf(signals({ deviceTypes: ['Tablet'] }))).toEqual(['mobile']);
    expect(cohortsOf(signals({ userAgent: 'Mozilla/5.0 (Macintosh)', deviceTypes: ['Desktop'] }))).toEqual([]);
  });

  it('combines shared network and API usage, and never reports assistive', () => {
    expect(cohortsOf(signals({ sharedSignupIp: true, apiAgentUsage: true }))).toEqual(['sharedNetwork', 'apiAgent']);
  });
});
