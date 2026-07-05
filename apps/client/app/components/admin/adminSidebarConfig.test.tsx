import { describe, it, expect } from 'vitest';
import { AdminTab, SIDEBAR_SECTIONS, SIDEBAR_EXPANDED_STORAGE_KEY, findSectionKeyForTab } from './adminSidebarConfig';

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

  it('only badges the Subscribers tab', () => {
    const badged = allItems.filter(i => i.badge);
    expect(badged).toHaveLength(1);
    expect(badged[0].tab).toBe(AdminTab.Subscribers);
    expect(badged[0].badge).toBe('waitingSubscribers');
  });
});

describe('findSectionKeyForTab', () => {
  it('returns the owning section key for a tab', () => {
    expect(findSectionKeyForTab(AdminTab.Users)).toBe('userOps');
    expect(findSectionKeyForTab(AdminTab.SecretsRotation)).toBe('security');
    expect(findSectionKeyForTab(AdminTab.SreAgent)).toBe('reliability');
    expect(findSectionKeyForTab(AdminTab.WorldTime)).toBe('generalOps');
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

describe('SIDEBAR_EXPANDED_STORAGE_KEY', () => {
  it('is a stable, namespaced localStorage key', () => {
    expect(SIDEBAR_EXPANDED_STORAGE_KEY).toBe('admin-sidebar-expanded-sections');
  });
});
