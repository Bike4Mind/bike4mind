import { describe, expect, it } from 'vitest';
import {
  ADMIN_ASSISTANT_SURFACE,
  ADMIN_ASSISTANT_TOOL_NAMES,
  isAdminAssistantGateOpen,
  isAdminAssistantToolName,
} from './adminAssistant';
import { getWorkspaceSurface } from './surfaces';

describe('isAdminAssistantGateOpen', () => {
  it('opens for an admin on the admin-assistant surface', () => {
    expect(isAdminAssistantGateOpen({ surface: 'admin-assistant' }, { isAdmin: true })).toBe(true);
  });
  it.each([
    [{ surface: 'admin-assistant' }, { isAdmin: false }],
    [{ surface: 'admin-assistant' }, { isAdmin: undefined }],
    [{ surface: null }, { isAdmin: true }],
    [{ surface: 'opti' }, { isAdmin: true }],
    [{ surface: 'Admin-Assistant' }, { isAdmin: true }],
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
