import { describe, it, expect } from 'vitest';
import { settingsMap } from '@bike4mind/common';

import { DEAD_SETTING_NAMES } from './20260921235993_drop-enable-team-plan-setting';

// Deleting a name that is a live setting key again would destroy a real admin row.
describe('drop-enable-team-plan-setting', () => {
  it('targets a non-empty list, so the guard below cannot pass vacuously', () => {
    expect(DEAD_SETTING_NAMES.length).toBeGreaterThan(0);
  });

  it.each(DEAD_SETTING_NAMES)('%s is not a live setting key', name => {
    expect(settingsMap).not.toHaveProperty(name);
  });
});
