import { describe, it, expect } from 'vitest';
import { settingsMap } from '@bike4mind/common';

import { premiumAdminSettings } from '../../../../apps/client/app/premium-generated/premiumAdminSettings.generated';
import { DEAD_SETTING_NAMES } from './20260911000000_drop-dead-feature-default-settings';

/**
 * The migration deletes `adminsettings` rows by name. That is only safe while those names are
 * absent from `settingsMap`: if one were ever re-added as a live setting, this migration would
 * delete a row an admin is actively using. Pin the two lists apart, without a database.
 */

describe('drop-dead-feature-default-settings', () => {
  it('targets a non-empty list, so the guard below cannot pass vacuously', () => {
    expect(DEAD_SETTING_NAMES.length).toBeGreaterThan(0);
  });

  it.each(DEAD_SETTING_NAMES)('%s is not a live setting key', name => {
    expect(settingsMap).not.toHaveProperty(name);
  });

  // Contributed settings never enter settingsMap, so check the mounted contribution list as well.
  it.each(DEAD_SETTING_NAMES)('%s is not a contributed setting key', name => {
    expect(premiumAdminSettings.map(s => s.key)).not.toContain(name);
  });
});
