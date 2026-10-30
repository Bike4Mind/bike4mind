// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { VIEW_REGISTRY } from '@bike4mind/common';
import { AdminTab, SIDEBAR_SECTIONS } from './adminSidebarConfig';
import { adminTabToSlug } from './adminTabSlugs';

// The admin assistant can only send an admin to a tab that VIEW_REGISTRY (b4m-core/common) names,
// and common cannot import AdminTab, so this is the one place the two lists are held together.
// useNavigationExecutor turns a 'tab' target into `/admin?tab=<slug>` via adminTabToSlug.
const adminTabViews = VIEW_REGISTRY.filter(view => view.requiresAdmin && view.navigationType === 'tab');
const sidebarTabs = SIDEBAR_SECTIONS.flatMap(section => section.items.map(item => item.tab));

describe('admin sidebar <-> VIEW_REGISTRY parity', () => {
  it('registers every sidebar tab as an admin tab view', () => {
    const registeredTargets = new Set(adminTabViews.map(view => view.target));
    const missing = sidebarTabs.filter(tab => !registeredTargets.has(String(tab))).map(tab => AdminTab[tab]);
    expect(missing, `AdminTab(s) in the sidebar with no VIEW_REGISTRY entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('points every admin tab view at a real tab', () => {
    const unresolvable = adminTabViews
      .filter(view => adminTabToSlug(Number(view.target)) === undefined)
      .map(view => `${view.id} -> ${view.target}`);
    expect(unresolvable, `VIEW_REGISTRY admin tab targets with no AdminTab slug: ${unresolvable.join(', ')}`).toEqual(
      []
    );
  });

  it('gives each admin tab a single view', () => {
    const idsByTarget = new Map<string, string[]>();
    for (const view of adminTabViews) {
      idsByTarget.set(view.target, [...(idsByTarget.get(view.target) ?? []), view.id]);
    }
    const duplicates = [...idsByTarget.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([target, ids]) => `${AdminTab[Number(target)]}: ${ids.join(', ')}`);
    expect(duplicates, `Admin tabs registered more than once: ${duplicates.join('; ')}`).toEqual([]);
  });
});
