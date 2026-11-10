// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { USAGE_EVENT_FEATURES } from '@bike4mind/common';
import { usageFeatureLabel } from './usageFeatureLabels';

describe('usageFeatureLabel', () => {
  it.each(USAGE_EVENT_FEATURES)('labels %s with something other than its raw id', feature => {
    const label = usageFeatureLabel(feature);
    expect(label).not.toBe(feature);
    expect(label).not.toMatch(/_/);
  });

  it('humanizes an id outside the enum', () => {
    expect(usageFeatureLabel('legacy_batch_job')).toBe('Batch Job');
  });
});
