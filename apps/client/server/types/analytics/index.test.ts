import { describe, it, expect } from 'vitest';
import { IntegrationsEvents } from '@bike4mind/common';
import { isValidEnumValue } from '@bike4mind/utils';
import { ANALYTICS_EVENTS } from './index';

describe('ANALYTICS_EVENTS', () => {
  // logEvent rejects anything outside this registry ("Invalid counter event"), and a family whose
  // key collides with another's is silently overwritten by the spread that builds it.
  it('registers every integrations gallery event', () => {
    for (const event of Object.values(IntegrationsEvents)) {
      expect(isValidEnumValue(event, ANALYTICS_EVENTS), event).toBe(true);
    }
  });
});
