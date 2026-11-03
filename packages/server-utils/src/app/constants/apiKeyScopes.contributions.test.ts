import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PremiumApiKeyScope } from '@bike4mind/common';
import type { ApiKeyScopeAccess, ApiKeyScopeOption } from './apiKeyScopes';

const GENERATED = '../../premium-generated/premiumApiKeyScopes.generated';

async function loadCatalog(premiumApiKeyScopes: unknown) {
  vi.resetModules();
  vi.doMock(GENERATED, () => ({ premiumApiKeyScopes }));
  return import('./apiKeyScopes');
}

afterEach(() => {
  vi.doUnmock(GENERATED);
  vi.restoreAllMocks();
});

const ACME_READ: PremiumApiKeyScope = {
  value: 'acme:read',
  label: 'Acme: Read',
  description: 'Read Acme records',
  endpoints: ['GET /api/acme'],
  requiredEntitlement: 'acme:pro',
};

const access = (overrides: Partial<ApiKeyScopeAccess> = {}): ApiKeyScopeAccess => ({
  hasOptiAccess: false,
  hasOverwatchAccess: false,
  hearthEnabled: false,
  bypass: false,
  entitlements: new Set(),
  ...overrides,
});

const BUILT_IN: ApiKeyScopeOption[] = [
  { value: 'me:read', label: 'Account: Read', description: 'Read the owner', endpoints: ['GET /api/v1/me'] },
];

describe('mergeContributedScopes', () => {
  it('appends a new contributed row after the built-in rows', async () => {
    const { mergeContributedScopes } = await loadCatalog([]);
    const rejected: string[] = [];
    const merged = mergeContributedScopes(BUILT_IN, [ACME_READ], { onReject: r => rejected.push(r) });
    expect(merged.map(s => s.value)).toEqual(['me:read', 'acme:read']);
    expect(merged[1].requiredEntitlement).toBe('acme:pro');
    expect(rejected).toEqual([]);
  });

  it('collapses a contribution repeating a built-in row, which keeps its own gate', async () => {
    const { mergeContributedScopes } = await loadCatalog([]);
    const rejected: string[] = [];
    const merged = mergeContributedScopes(BUILT_IN, [{ ...BUILT_IN[0], requiredEntitlement: 'acme:pro' }], {
      onReject: r => rejected.push(r),
    });
    expect(merged).toEqual(BUILT_IN);
    expect(rejected).toEqual([]);
  });

  it('collapses an identical contributed duplicate', async () => {
    const { mergeContributedScopes } = await loadCatalog([]);
    const rejected: string[] = [];
    const merged = mergeContributedScopes(BUILT_IN, [ACME_READ, { ...ACME_READ }], { onReject: r => rejected.push(r) });
    expect(merged.map(s => s.value)).toEqual(['me:read', 'acme:read']);
    expect(rejected).toEqual([]);
  });

  it('drops and reports a colliding or malformed row without throwing, keeping the first row', async () => {
    const { mergeContributedScopes } = await loadCatalog([]);
    const rejected: string[] = [];
    const merged = mergeContributedScopes(
      BUILT_IN,
      [
        ACME_READ,
        { ...ACME_READ, requiredEntitlement: 'acme:other' },
        { ...BUILT_IN[0], label: 'Renamed' },
        { value: 'admin:*', label: 'x', description: 'x', endpoints: [] },
        { value: 'Not A Scope', label: 'x', description: 'x', endpoints: [] },
        null as unknown as PremiumApiKeyScope,
      ],
      { onReject: r => rejected.push(r) }
    );
    expect(merged.map(s => s.value)).toEqual(['me:read', 'acme:read']);
    expect(merged[0].label).toBe('Account: Read');
    expect(merged[1].requiredEntitlement).toBe('acme:pro');
    expect(rejected).toHaveLength(5);
  });

  it.each([
    ['a reserved resource', { ...ACME_READ, value: 'datalake:export' }],
    ['a wildcard action', { ...ACME_READ, value: 'acme:*' }],
    ['an empty requiredEntitlement', { ...ACME_READ, requiredEntitlement: '' }],
  ])('drops a row with %s rather than offering it', async (_label, row) => {
    const { mergeContributedScopes } = await loadCatalog([]);
    const rejected: string[] = [];
    const merged = mergeContributedScopes(BUILT_IN, [row], { onReject: r => rejected.push(r) });
    expect(merged).toEqual(BUILT_IN);
    expect(rejected).toHaveLength(1);
  });

  it('treats a non-array contribution as none', async () => {
    const { mergeContributedScopes } = await loadCatalog([]);
    expect(mergeContributedScopes(BUILT_IN, { value: 'acme:read' } as unknown as PremiumApiKeyScope[])).toEqual(
      BUILT_IN
    );
  });
});

describe('the catalog with a contributed scope', () => {
  it('lists it as user-selectable and known, and never as a dedicated-flow scope', async () => {
    const catalog = await loadCatalog([ACME_READ]);
    expect(catalog.USER_API_KEY_SCOPE_VALUES).toContain('acme:read');
    expect(catalog.GENERIC_MODAL_API_KEY_SCOPES.map(s => s.value)).toContain('acme:read');
    expect(catalog.DEDICATED_FLOW_SCOPES.has('acme:read')).toBe(false);
    expect(catalog.isKnownApiKeyScope('acme:read')).toBe(true);
    expect(catalog.isKnownApiKeyScope('admin:*')).toBe(true);
    expect(catalog.isKnownApiKeyScope('acme:write')).toBe(false);
  });

  it('offers it only with its entitlement or the admin/developer bypass', async () => {
    const { isApiKeyScopeOffered } = await loadCatalog([ACME_READ]);
    expect(isApiKeyScopeOffered('acme:read', access())).toBe(false);
    expect(isApiKeyScopeOffered('acme:read', access({ entitlements: new Set(['other:pro']) }))).toBe(false);
    expect(isApiKeyScopeOffered('acme:read', access({ entitlements: new Set(['acme:pro']) }))).toBe(true);
    expect(isApiKeyScopeOffered('acme:read', access({ bypass: true }))).toBe(true);
  });

  it('keys the generic list on the entitlements, with a stable reference per combination', async () => {
    const { genericApiKeyScopesFor } = await loadCatalog([ACME_READ]);
    const without = genericApiKeyScopesFor(access({ entitlements: new Set(['other:pro']) }));
    const withIt = genericApiKeyScopesFor(access({ entitlements: new Set(['acme:pro']) }));
    expect(without.map(s => s.value)).not.toContain('acme:read');
    expect(withIt.map(s => s.value)).toContain('acme:read');
    expect(genericApiKeyScopesFor(access({ entitlements: new Set(['acme:pro', 'other:pro']) }))).toBe(withIt);
    expect(genericApiKeyScopesFor(access())).toBe(without);
  });

  it('warns once at load about a dropped row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const catalog = await loadCatalog([{ ...ACME_READ, value: 'me:read' }]);
    expect(catalog.USER_API_KEY_SCOPE_VALUES.filter(v => v === 'me:read')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('me:read'));
  });
});
