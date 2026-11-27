// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { config, warn } = vi.hoisted(() => ({
  config: { ADMIN_SENIOR_GRANTER_IDS: undefined as string | undefined },
  warn: vi.fn(),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: config }));
vi.mock('@bike4mind/observability', () => ({ Logger: { globalInstance: { warn } } }));

import {
  assertListedForExplicitOnly,
  fenceExplicitOnlyPermissions,
  isSeniorGranter,
  parseSeniorGranterIds,
} from './seniorGranters';

// Fake ids only.
const A = 'a00000000000000000000001';
const B = 'b00000000000000000000002';

beforeEach(() => {
  vi.clearAllMocks();
  config.ADMIN_SENIOR_GRANTER_IDS = undefined;
});

describe('parseSeniorGranterIds', () => {
  it('trims entries and drops empties', () => {
    expect([...parseSeniorGranterIds(` ${A} ,, ${B},`)]).toEqual([A, B]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores anything but a 24-hex id and warns with the count, never the entry', () => {
    const ids = parseSeniorGranterIds(`${A},admin@example.com,${B.slice(1)},${'z'.repeat(24)}`);
    expect([...ids]).toEqual([A]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { ignored: 3 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('example.com');
  });

  it.each([undefined, '', ' , '])('is empty for %j', raw => {
    expect(parseSeniorGranterIds(raw).size).toBe(0);
  });
});

describe('isSeniorGranter', () => {
  it('fails closed when the list is unset', () => {
    expect(isSeniorGranter(A)).toBe(false);
  });

  it('matches listed ids only, and follows a changed list', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = A;
    expect(isSeniorGranter(A)).toBe(true);
    expect(isSeniorGranter(B)).toBe(false);
    expect(isSeniorGranter(undefined)).toBe(false);

    config.ADMIN_SENIOR_GRANTER_IDS = B;
    expect(isSeniorGranter(A)).toBe(false);
    expect(isSeniorGranter(B)).toBe(true);
  });

  it('parses the list once per value, so an invalid entry warns once', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = `${A},not-an-id`;
    isSeniorGranter(A);
    isSeniorGranter(B);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('fenceExplicitOnlyPermissions', () => {
  const actor = {
    id: A,
    adminPermissions: ['credits:adjust', 'credits:approve_self_grant'],
    roleAdminPermissions: ['credits:self_grant', 'support:read'],
  };

  it('leaves a listed account in its own session unchanged', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = A;
    expect(fenceExplicitOnlyPermissions(actor)).toBe(actor);
  });

  it('strips the explicit-only permissions, direct and from roles, from an unlisted account', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = B;
    expect(fenceExplicitOnlyPermissions(actor)).toEqual({
      id: A,
      adminPermissions: ['credits:adjust'],
      roleAdminPermissions: ['support:read'],
    });
  });

  it('strips them from a session impersonating a listed account', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = A;
    const fenced = fenceExplicitOnlyPermissions({ ...actor, impersonatedBy: B });
    expect(fenced.adminPermissions).toEqual(['credits:adjust']);
    expect(fenced.roleAdminPermissions).toEqual(['support:read']);
  });

  it('strips them when the list is unset', () => {
    expect(fenceExplicitOnlyPermissions(actor).adminPermissions).toEqual(['credits:adjust']);
  });
});

describe('assertListedForExplicitOnly', () => {
  it('refuses giving an unlisted account an explicit-only permission', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = A;
    expect(() =>
      assertListedForExplicitOnly(B, ['credits:adjust'], ['credits:adjust', 'credits:approve_self_grant'])
    ).toThrow("credits:approve_self_grant can only be held by an account on the deployment's senior granter list");
  });

  it('allows it for a listed account', () => {
    config.ADMIN_SENIOR_GRANTER_IDS = A;
    expect(() =>
      assertListedForExplicitOnly(A, [], ['credits:self_grant', 'credits:approve_self_grant'])
    ).not.toThrow();
  });

  it('never refuses a removal, an unchanged holding or an ordinary permission', () => {
    expect(() => assertListedForExplicitOnly(B, ['credits:self_grant'], [])).not.toThrow();
    expect(() => assertListedForExplicitOnly(B, ['credits:self_grant'], ['credits:self_grant'])).not.toThrow();
    expect(() => assertListedForExplicitOnly(B, [], ['credits:adjust'])).not.toThrow();
  });
});
