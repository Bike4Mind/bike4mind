// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { registerContributedSettings } from '@bike4mind/common';
import { premiumAdminSettings } from '@client/app/premium-generated/premiumAdminSettings.generated';

describe('contributed admin settings', () => {
  it('no contributed admin setting fails registration (e.g. a sensitive setting with a default)', () => {
    expect(registerContributedSettings(premiumAdminSettings).rejected).toEqual([]);
  });
});
