import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ADMIN_ACTION_COUNT_KEYS } from '@bike4mind/server-utils/app/components/admin/adminActionCounts';
import {
  AdminTab,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_MORE_STORAGE_KEY,
  SIDEBAR_MORE_THRESHOLD,
  SIDEBAR_MORE_VISIBLE,
  SIDEBAR_SECTIONS,
  filterSidebarSections,
  findSectionKeyForTab,
  isSamePagePath,
  sectionEntries,
  splitSectionEntries,
  splitSectionItems,
  type SidebarPageLink,
  type SidebarSection,
} from './adminSidebarConfig';
import { ADMIN_SIDEBAR_SECTION_KEYS } from './adminSidebarSectionKeys';

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
    expect(testidByTab.get(AdminTab.Waitlist)).toBe('admin-waitlist-tab-btn');
    expect(testidByTab.get(AdminTab.SecurityDashboard)).toBe('admin-security-dashboard-btn');
    expect(testidByTab.get(AdminTab.DlqReplay)).toBe('admin-dlq-replay-btn');
    expect(testidByTab.get(AdminTab.HelpAnalytics)).toBe('admin-help-analytics-btn');
  });

  it('only gates the tabs that were previously conditionally rendered', () => {
    const gatedByTab = new Map(allItems.filter(i => i.gate).map(i => [i.tab, i.gate]));
    expect(gatedByTab.get(AdminTab.Migrate)).toBe('userMigration');
    // Nothing else should be gated.
    expect(gatedByTab.size).toBe(1);
  });

  it('has no item for the retired issue filing page, which lives on the Security page', () => {
    expect(allItems.some(i => i.tab === AdminTab.SecOpsTriage)).toBe(false);
  });

  it('labels the Waitlist item Invite Center', () => {
    expect(allItems.find(i => i.tab === AdminTab.Waitlist)?.label).toBe('Invite Center');
  });

  it.each([AdminTab.RegistrationInvites, AdminTab.PartnerSignupRules, AdminTab.HeldSignupGrants])(
    'has no sidebar item for retired Invite Center tab %s',
    tab => expect(allItems.some(item => item.tab === tab)).toBe(false)
  );

  it('preserves the retired numeric slots', () => {
    expect([AdminTab.RegistrationInvites, AdminTab.PartnerSignupRules, AdminTab.HeldSignupGrants]).toEqual([5, 55, 70]);
  });

  it('labels the secrets item with its page title', () => {
    expect(allItems.find(i => i.tab === AdminTab.SystemSecrets)?.label).toBe('System secrets');
  });

  it('names the event, Slack and help metrics items like their page titles', () => {
    const labelOf = (tab: AdminTab) => allItems.find(i => i.tab === tab)?.label;
    expect(labelOf(AdminTab.EventMetrics)).toBe('Event metrics');
    expect(labelOf(AdminTab.SlackMetrics)).toBe('Slack metrics');
    expect(labelOf(AdminTab.HelpAnalytics)).toBe('Help analytics');
  });

  it('names the integration items like their page titles', () => {
    const labelOf = (tab: AdminTab) => allItems.find(i => i.tab === tab)?.label;
    expect(labelOf(AdminTab.WebhookAuditLogs)).toBe('Webhook audit logs');
    expect(labelOf(AdminTab.SlackWorkspaces)).toBe('Slack workspaces');
    expect(labelOf(AdminTab.GitHubConnection)).toBe('GitHub connection');
  });

  it('badges each counted queue once, and Subscriptions with its dot', () => {
    const badges = allItems.flatMap(item => [item.badge, item.delegateBadge].filter(Boolean));
    expect(badges.sort()).toEqual([...ADMIN_ACTION_COUNT_KEYS, 'newSubscriptions'].sort());
    expect(allItems.find(item => item.badge === 'newSubscriptions')?.tab).toBe(AdminTab.Subscriptions);
  });
});

describe('findSectionKeyForTab', () => {
  it('returns the owning section key for a tab', () => {
    expect(findSectionKeyForTab(AdminTab.Dashboard)).toBe('overview');
    expect(findSectionKeyForTab(AdminTab.Users)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.Waitlist)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.EmailMarketing)).toBe('people');
    expect(findSectionKeyForTab(AdminTab.CreditAnalytics)).toBe('money');
    expect(findSectionKeyForTab(AdminTab.SystemSecrets)).toBe('trust');
    expect(findSectionKeyForTab(AdminTab.Models)).toBe('ai');
    expect(findSectionKeyForTab(AdminTab.SreAgent)).toBe('platform');
    expect(findSectionKeyForTab(AdminTab.AdminSettings)).toBe('settings');
  });

  it('resolves every referenced tab to exactly one section', () => {
    for (const item of allItems) {
      expect(findSectionKeyForTab(item.tab)).toBeDefined();
    }
  });

  it('returns undefined for a tab with no sidebar entry', () => {
    // Files/ModelLogs exist in the enum but have no sidebar button.
    expect(findSectionKeyForTab(AdminTab.Files)).toBeUndefined();
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

  it('keeps items with work waiting past the cut, in section order, alongside the active one', () => {
    const [first, second, third] = people.slice(SIDEBAR_MORE_VISIBLE);
    const { shown, hiddenCount } = splitSectionItems(
      people,
      second.tab,
      false,
      item => item.tab === third.tab || item.tab === first.tab
    );

    expect(shown).toEqual([...people.slice(0, SIDEBAR_MORE_VISIBLE), first, second, third]);
    expect(hiddenCount).toBe(people.length - SIDEBAR_MORE_VISIBLE - 3);
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

  it('does not mount retired Invite Center panels', () => {
    const panelTabs = panels.map(([, tab]) => tab);
    expect(panelTabs).not.toContain('RegistrationInvites');
    expect(panelTabs).not.toContain('PartnerSignupRules');
    expect(panelTabs).not.toContain('HeldSignupGrants');
  });

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

describe('ADMIN_SIDEBAR_SECTION_KEYS', () => {
  it('lists the keys of SIDEBAR_SECTIONS, in order, so a contributed page can name a section', () => {
    expect([...ADMIN_SIDEBAR_SECTION_KEYS]).toEqual(SIDEBAR_SECTIONS.map(section => section.key));
  });

  it('leaves SIDEBAR_SECTIONS free of contributed pages', () => {
    expect(SIDEBAR_SECTIONS.filter(section => section.pages !== undefined)).toEqual([]);
  });
});

describe('contributed pages in a section', () => {
  const Icon = () => null;
  const link = (label: string, path = `/admin/ext/${label.toLowerCase()}`): SidebarPageLink => ({
    Icon,
    label,
    path,
    testid: `page-${label.toLowerCase()}`,
  });
  const gates = { userMigration: true };
  const withPages = (key: string, pages: SidebarPageLink[]): SidebarSection[] =>
    SIDEBAR_SECTIONS.map(section => (section.key === key ? { ...section, pages } : section));

  it('lists the tab items first, then the pages', () => {
    const money = withPages('money', [link('Reports'), link('Audits')]).find(section => section.key === 'money')!;
    const entries = sectionEntries(money);

    expect(entries.map(entry => entry.kind)).toEqual([...money.items.map(() => 'tab'), 'page', 'page']);
    expect(entries.slice(-2).map(entry => (entry.kind === 'page' ? entry.page.label : ''))).toEqual([
      'Reports',
      'Audits',
    ]);
  });

  it('counts a page toward the More threshold and hides it behind More like a trailing item', () => {
    const entries = sectionEntries(withPages('platform', [link('Reports')]).find(s => s.key === 'platform')!);
    const page = entries[entries.length - 1];

    const collapsed = splitSectionEntries(entries, false, () => false);
    expect(collapsed.shown).toEqual(entries.slice(0, SIDEBAR_MORE_VISIBLE));
    expect(collapsed.hiddenCount).toBe(entries.length - SIDEBAR_MORE_VISIBLE);
    expect(collapsed.shown).not.toContain(page);

    expect(splitSectionEntries(entries, true, () => false).shown).toEqual(entries);
    expect(splitSectionEntries(entries, false, entry => entry === page).shown).toEqual([
      ...entries.slice(0, SIDEBAR_MORE_VISIBLE),
      page,
    ]);
  });

  it('keeps a short section whole when a page brings it to the threshold, and cuts it one past', () => {
    const overview = SIDEBAR_SECTIONS.find(section => section.key === 'overview')!;
    const room = SIDEBAR_MORE_THRESHOLD - overview.items.length;
    const fits = sectionEntries({ ...overview, pages: Array.from({ length: room }, (_, i) => link(`P${i}`)) });
    const over = sectionEntries({ ...overview, pages: Array.from({ length: room + 1 }, (_, i) => link(`P${i}`)) });

    expect(splitSectionEntries(fits, false, () => false).hiddenCount).toBe(0);
    expect(splitSectionEntries(over, false, () => false).hiddenCount).toBe(over.length - SIDEBAR_MORE_VISIBLE);
  });

  it('keeps splitSectionItems identical to the generic split for tab items', () => {
    const people = SIDEBAR_SECTIONS.find(section => section.key === 'people')!.items;
    expect(splitSectionItems(people, AdminTab.Users, false)).toEqual(
      splitSectionEntries(people, false, item => item.tab === AdminTab.Users)
    );
  });

  it('filters pages by label and by section label, and drops a section left empty', () => {
    const sections = withPages('money', [link('Reports')]);

    const byLabel = filterSidebarSections(sections, gates, 'report');
    expect(byLabel.map(section => section.key)).toEqual(['money']);
    expect(byLabel[0].items).toEqual([]);
    expect(byLabel[0].pages?.map(page => page.label)).toEqual(['Reports']);

    const bySection = filterSidebarSections(sections, gates, 'money');
    expect(bySection[0].pages?.map(page => page.label)).toEqual(['Reports']);
    expect(bySection[0].items.length).toBeGreaterThan(0);

    expect(filterSidebarSections(sections, gates, 'zzz-no-match')).toEqual([]);
  });

  it('drops the pages canOpenPage refuses, and the section they leave empty', () => {
    const sections = withPages('money', [link('Reports')]);

    const refused = filterSidebarSections(
      sections,
      gates,
      'report',
      () => true,
      () => false
    );
    expect(refused).toEqual([]);

    const unfiltered = filterSidebarSections(
      sections,
      gates,
      '',
      () => true,
      () => false
    );
    expect(unfiltered.find(section => section.key === 'money')?.pages).toEqual([]);
  });

  it('adds no pages key to a section that had none', () => {
    const sections = filterSidebarSections(SIDEBAR_SECTIONS, gates, '');
    expect(sections.every(section => !('pages' in section))).toBe(true);
    expect(sections).toEqual(SIDEBAR_SECTIONS);
  });

  it('compares page paths across a trailing slash and letter case', () => {
    expect(isSamePagePath('/admin/ext/reports', '/admin/ext/reports')).toBe(true);
    expect(isSamePagePath('/admin/ext/reports', '/admin/ext/reports/')).toBe(true);
    expect(isSamePagePath('/admin/ext/reports', '/Admin/Ext/Reports')).toBe(true);
    expect(isSamePagePath('/admin/ext/reports', '/admin/ext/reports-2')).toBe(false);
  });
});
