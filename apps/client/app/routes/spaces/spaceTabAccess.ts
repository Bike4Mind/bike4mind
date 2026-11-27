// Tab identity and per-role visibility for the Space detail route.

import type { SpaceRole } from '@client/app/hooks/data/spaces';

export enum SpaceTabs {
  Members = 'members',
  Invites = 'invites',
  Links = 'links',
  Domains = 'domains',
  Settings = 'settings',
}

const MANAGER_TABS = [SpaceTabs.Members, SpaceTabs.Invites, SpaceTabs.Links, SpaceTabs.Domains, SpaceTabs.Settings];

export const isSpaceManager = (role: SpaceRole | undefined): boolean => role === 'owner' || role === 'admin';

/** Plain members see the roster only; owners and admins manage the rest. */
export function visibleSpaceTabs(role: SpaceRole | undefined): SpaceTabs[] {
  return isSpaceManager(role) ? MANAGER_TABS : [SpaceTabs.Members];
}

/** An unknown or hidden tab falls back to Members, so a stale `?tab=` never shows an empty page. */
export function resolveSpaceTab(requested: string | undefined, role: SpaceRole | undefined): SpaceTabs {
  return visibleSpaceTabs(role).find(tab => tab === requested) ?? SpaceTabs.Members;
}
