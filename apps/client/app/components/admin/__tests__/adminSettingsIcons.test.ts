/**
 * IconMap completeness guard for AdminSettingsTab.
 *
 * renderSettingGroup / renderCategory / the tab bar resolve a group's, category's,
 * or tab's icon name against IconMap and render it directly (`<IconComponent />`).
 * When a configured icon name has no IconMap entry the lookup yields `undefined`,
 * and rendering `<undefined />` throws "Element type is invalid" -- a white-screen
 * crash. Production hit this via the API Rate Limiting group's 'Speed' icon, which
 * only became visible in All-Tabs search mode. This test fails if any icon name in
 * the settings config drifts away from IconMap again.
 */
import { describe, it, expect } from 'vitest';
import { API_SERVICE_GROUPS, CATEGORY_ICONS, SETTING_TABS } from '@bike4mind/common';
import { IconMap } from '../AdminSettingsTab';

const referencedIcons: { icon: string; source: string }[] = [
  ...Object.values(API_SERVICE_GROUPS).map(g => ({ icon: g.icon, source: `API_SERVICE_GROUPS.${g.id}` })),
  ...Object.entries(CATEGORY_ICONS).map(([category, icon]) => ({ icon, source: `CATEGORY_ICONS.${category}` })),
  ...Object.values(SETTING_TABS).map(t => ({ icon: t.icon, source: `SETTING_TABS.${t.id}` })),
];

describe('AdminSettingsTab IconMap completeness', () => {
  it.each(referencedIcons)('maps "$icon" referenced by $source to a component', ({ icon }) => {
    expect(IconMap[icon]).toBeDefined();
  });

  // The it.each above already asserts 'Speed' is present (it's RATE_LIMITING's icon).
  // This anchor adds the part that check can't: 'Speed' must be its OWN entry, not
  // aliased to the Settings fallback -- otherwise the group would silently show the
  // generic gear instead of the speedometer that regressed in production.
  it('maps "Speed" to a dedicated icon, not the Settings fallback (regression: All-Tabs white-screen crash)', () => {
    expect(IconMap.Speed).toBeDefined();
    expect(IconMap.Speed).not.toBe(IconMap.Settings);
  });
});
