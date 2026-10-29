import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdminTab,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_MORE_STORAGE_KEY,
  SIDEBAR_MORE_THRESHOLD,
  SIDEBAR_MORE_VISIBLE,
  SIDEBAR_SECTIONS,
  findSectionKeyForTab,
  splitSectionItems,
} from './adminSidebarConfig';

const allItems = SIDEBAR_SECTIONS.flatMap(section => section.items);

describe('SIDEBAR_SECTIONS', () => {
  it('renders exactly one button per referenced AdminTab (no duplicates)', () => {
    const tabs = allItems.map(item => item.tab);
    const unique = new Set(tabs);
    expect(unique.size).toBe(tabs.length);
  });

  it('references real AdminTab enum values only', () => {
    const validTabs = new Set(Object.values(AdminTab).filter((v): v is AdminTab => typeof v === 'number'));
    for (const item of allItems) {
      expect(validTabs.has(item.tab)).toBe(true);
    }
  });

  it('gives every section a stable, unique key', () => {
    const keys = SIDEBAR_SECTIONS.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('uses the redesigned section keys and sentence-case labels, in order', () => {
    expect(SIDEBAR_SECTIONS.map(s => [s.key, s.label])).toEqual([
      ['overview', 'Overview'],
      ['people', 'People'],
      ['money', 'Money'],
      ['trust', 'Trust and safety'],
      ['ai', 'AI'],
      ['platform', 'Platform'],
      ['settings', 'Settings'],
    ]);
  });

  it('lists Dashboard as the first Overview item', () => {
    expect(SIDEBAR_SECTIONS[0].items[0].tab).toBe(AdminTab.Dashboard);
  });

  it('gives every item a non-empty label and icon', () => {
    for (const item of allItems) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.Icon).toBeDefined();
    }
  });

  it('keeps the data-testid values used by existing E2E selectors', () => {
    const testidByTab = new Map(allItems.filter(i => i.testid).map(i => [i.tab, i.testid]));
    // Spot-check the testids referenced by existing E2E flows.
    expect(testidByTab.get(AdminTab.Users)).toBe('admin-users-tab-btn');
    expect(testidByTab.get(AdminTab.RegistrationInvites)).toBe('admin-invite-center-tab-btn');
    expect(testidByTab.get(AdminTab.SecOpsTriage)).toBe('admin-secops-triage-btn');
    expect(testidByTab.get(AdminTab.SecurityDashboard)).toBe('admin-security-dashboard-btn');
    expect(testidByTab.get(AdminTab.DlqReplay)).toBe('admin-dlq-replay-btn');
    expect(testidByTab.get(AdminTab.HelpAnalytics)).toBe('admin-help-analytics-btn');
  });

  it('only gates the tabs that were previously conditionally rendered', () => {
    const gatedByTab = new Map(allItems.filter(i => i.gate).map(i => [i.tab, i.gate]));
    expect(gatedByTab.get(AdminTab.Migrate)).toBe('userMigration');
    expect(gatedByTab.get(AdminTab.LiveOpsTriage)).toBe('liveOpsTriage');
    // Nothing else should be gated.
    expect(gatedByTab.size).toBe(2);
  });

  it('only badges the Waitlist and Subscriptions tabs', () => {
    const badged = allItems.filter(i => i.badge).map(i => [i.tab, i.badge]);
    expect(badged).toEqual([
      [AdminTab.Waitlist, 'waitingSubscribers'],
      [AdminTab.Subscriptions, 'newSubscriptions'],
    ]);
  });
});

describe('findSectionKeyForTab', () => {
  it('returns the owning section key for a tab', () => {
    expect(findSectionKeyForTab(AdminTab.Dashboard)).toBe('overview');
    expect(findSectionKeyForTab(AdminTab.Users)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.Waitlist)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.EmailMarketing)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.CreditAnalytics)).toBe('money');
    expect(findSectionKeyForTab(AdminTab.SecretsRotation)).toBe('trust');
    expect(findSectionKeyForTab(AdminTab.LLMDashboard)).toBe('ai');
    expect(findSectionKeyForTab(AdminTab.SreAgent)).toBe('platform');
    expect(findSectionKeyForTab(AdminTab.AdminSettings)).toBe('settings');
  });

  it('resolves every referenced tab to exactly one section', () => {
    for (const item of allItems) {
      expect(findSectionKeyForTab(item.tab)).toBeDefined();
    }
  });

  it('returns undefined for a tab with no sidebar entry', () => {
    // Files/Accounts/ModelLogs exist in the enum but have no sidebar button.
    expect(findSectionKeyForTab(AdminTab.Files)).toBeUndefined();
    expect(findSectionKeyForTab(AdminTab.Accounts)).toBeUndefined();
    expect(findSectionKeyForTab(AdminTab.ModelLogs)).toBeUndefined();
  });

  it('returns undefined for null or an unknown string tab', () => {
    expect(findSectionKeyForTab(null)).toBeUndefined();
    expect(findSectionKeyForTab('not-a-tab')).toBeUndefined();
  });
});

describe('sidebar storage keys and More limits', () => {
  it('uses stable, namespaced localStorage keys', () => {
    expect(SIDEBAR_COLLAPSED_STORAGE_KEY).toBe('admin-sidebar-collapsed');
    expect(SIDEBAR_MORE_STORAGE_KEY).toBe('admin-sidebar-more-sections');
  });

  it('shows fewer items than the threshold that triggers More', () => {
    expect(SIDEBAR_MORE_VISIBLE).toBeLessThan(SIDEBAR_MORE_THRESHOLD);
  });
});

describe('splitSectionItems', () => {
  const people = SIDEBAR_SECTIONS.find(section => section.key === 'people')!.items;
  const short = people.slice(0, SIDEBAR_MORE_THRESHOLD);

  it('returns every item of a section at or under the threshold', () => {
    expect(splitSectionItems(short, null, false)).toEqual({ shown: short, hiddenCount: 0 });
  });

  it('cuts a long collapsed section to the visible head and counts the rest', () => {
    const { shown, hiddenCount } = splitSectionItems(people, AdminTab.Users, false);

    expect(shown).toEqual(people.slice(0, SIDEBAR_MORE_VISIBLE));
    expect(hiddenCount).toBe(people.length - SIDEBAR_MORE_VISIBLE);
  });

  it('returns everything when expanded', () => {
    expect(splitSectionItems(people, null, true)).toEqual({ shown: people, hiddenCount: 0 });
  });

  it('appends an active item past the cut and decrements the hidden count', () => {
    const tail = people[SIDEBAR_MORE_VISIBLE + 1];
    const { shown, hiddenCount } = splitSectionItems(people, tail.tab, false);

    expect(shown).toEqual([...people.slice(0, SIDEBAR_MORE_VISIBLE), tail]);
    expect(hiddenCount).toBe(people.length - SIDEBAR_MORE_VISIBLE - 1);
  });

  it('does not duplicate an active item already in the visible head', () => {
    const { shown } = splitSectionItems(people, people[0].tab, false);

    expect(shown).toHaveLength(SIDEBAR_MORE_VISIBLE);
  });
});

/**
 * The sidebar and AdminPage's TabPanels are two hand-maintained lists of the same enum, so they
 * can drift silently: a tab whose panel carries the wrong `value` is mounted only while a
 * DIFFERENT tab is selected, which means it never renders and no component test notices - the
 * component renders fine in isolation. These parse the source rather than mounting AdminPage,
 * which pulls in most of the admin surface.
 */
describe('AdminPage tab wiring', () => {
  const adminPageSource = readFileSync(join(__dirname, 'AdminPage.tsx'), 'utf8');

  const panels = [...adminPageSource.matchAll(/<TabPanel\s+value=\{AdminTab\.(\w+)\}[^>]*>([\s\S]*?)<\/TabPanel>/g)];

  it('guards each panel body with the same tab the panel is keyed to', () => {
    const mismatches = panels.flatMap(([, panelTab, body]) =>
      [...body.matchAll(/activeTab === AdminTab\.(\w+)/g)]
        .map(([, guardTab]) => guardTab)
        .filter(guardTab => guardTab !== panelTab)
        .map(guardTab => `<TabPanel value={AdminTab.${panelTab}}> renders AdminTab.${guardTab}`)
    );
    expect(mismatches).toEqual([]);
  });

  it('gives every sidebar button a panel to render into', () => {
    const panelTabs = new Set(panels.map(([, panelTab]) => panelTab));
    const tabNameByValue = new Map(
      Object.entries(AdminTab)
        .filter((entry): entry is [string, AdminTab] => typeof entry[1] === 'number')
        .map(([name, value]) => [value, name])
    );
    const orphans = allItems.map(item => tabNameByValue.get(item.tab)).filter(name => !name || !panelTabs.has(name));
    expect(orphans).toEqual([]);
  });
});
