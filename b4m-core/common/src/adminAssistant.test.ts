import { describe, expect, it } from 'vitest';
import {
  ADMIN_ASSISTANT_SURFACE,
  ADMIN_ASSISTANT_TOOL_NAMES,
  isAdminAssistantGateOpen,
  isAdminAssistantToolName,
} from './adminAssistant';
import { getWorkspaceSurface } from './surfaces';

describe('isAdminAssistantGateOpen', () => {
  it('opens for an admin on the admin-assistant surface in their own session', () => {
    expect(
      isAdminAssistantGateOpen({ surface: 'admin-assistant', userId: 'admin1' }, { isAdmin: true, id: 'admin1' })
    ).toBe(true);
  });
  it.each([
    [
      { surface: 'admin-assistant', userId: 'u1' },
      { isAdmin: false, id: 'u1' },
    ],
    [
      { surface: 'admin-assistant', userId: 'u1' },
      { isAdmin: undefined, id: 'u1' },
    ],
    [
      { surface: null, userId: 'u1' },
      { isAdmin: true, id: 'u1' },
    ],
    [
      { surface: 'opti', userId: 'u1' },
      { isAdmin: true, id: 'u1' },
    ],
    [
      { surface: 'Admin-Assistant', userId: 'u1' },
      { isAdmin: true, id: 'u1' },
    ],
    [
      { surface: 'admin-assistant', userId: 'someone-else' },
      { isAdmin: true, id: 'admin1' },
    ],
    [{ surface: 'admin-assistant' }, { isAdmin: true, id: 'admin1' }],
    [{ surface: 'admin-assistant', userId: 'admin1' }, { isAdmin: true }],
  ])('stays closed for %o / %o', (session, user) => {
    expect(isAdminAssistantGateOpen(session, user)).toBe(false);
  });
});

describe('isAdminAssistantToolName', () => {
  it('accepts every declared tool name and rejects others', () => {
    for (const name of ADMIN_ASSISTANT_TOOL_NAMES) expect(isAdminAssistantToolName(name)).toBe(true);
    expect(isAdminAssistantToolName('admin_delete_user')).toBe(false);
  });
});

it('ADMIN_ASSISTANT_SURFACE is not a registered workspace surface', () => {
  expect(getWorkspaceSurface(ADMIN_ASSISTANT_SURFACE)).toBeUndefined();
});
