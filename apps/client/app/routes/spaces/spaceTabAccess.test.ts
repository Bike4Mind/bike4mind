import { describe, expect, it } from 'vitest';
import { isSpaceManager, resolveSpaceTab, SpaceTabs, visibleSpaceTabs } from './spaceTabAccess';

describe('visibleSpaceTabs', () => {
  it('gives an owner every tab', () => {
    expect(visibleSpaceTabs('owner')).toEqual([
      SpaceTabs.Members,
      SpaceTabs.Invites,
      SpaceTabs.Links,
      SpaceTabs.Domains,
      SpaceTabs.Settings,
    ]);
  });

  it('gives an admin every tab', () => {
    expect(visibleSpaceTabs('admin')).toEqual(visibleSpaceTabs('owner'));
  });

  it('gives a plain member the roster only', () => {
    expect(visibleSpaceTabs('member')).toEqual([SpaceTabs.Members]);
  });

  it('gives nobody extra tabs before the role is known', () => {
    expect(visibleSpaceTabs(undefined)).toEqual([SpaceTabs.Members]);
  });
});

describe('resolveSpaceTab', () => {
  it('honours a visible tab', () => {
    expect(resolveSpaceTab('links', 'admin')).toBe(SpaceTabs.Links);
  });

  it('falls back to members for a tab the role cannot see', () => {
    expect(resolveSpaceTab('settings', 'member')).toBe(SpaceTabs.Members);
  });

  it('falls back to members for an unknown or missing tab', () => {
    expect(resolveSpaceTab('nope', 'owner')).toBe(SpaceTabs.Members);
    expect(resolveSpaceTab(undefined, 'owner')).toBe(SpaceTabs.Members);
  });
});

describe('isSpaceManager', () => {
  it('is true for owner and admin only', () => {
    expect(isSpaceManager('owner')).toBe(true);
    expect(isSpaceManager('admin')).toBe(true);
    expect(isSpaceManager('member')).toBe(false);
  });
});
