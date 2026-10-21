import { describe, expect, it } from 'vitest';
import type { SettingKey } from '../schemas/settings';
import { INTEGRATION_CATALOG, type Integration } from './catalog';
import { deriveIntegrationStatus, deriveStatus, isSettingChainOn, type IntegrationStatusContext } from './status';

const context = (on: readonly SettingKey[], isAdmin = false): IntegrationStatusContext => ({
  isFlagOn: key => on.includes(key),
  isAdmin,
});

describe('deriveStatus', () => {
  const FLAG: SettingKey = 'EnableMCPServer';

  it.each([
    // stage, flags, flag on, admin, connected -> status, betaTag, adminOnly
    ['ga', [], false, false, false, 'available', false, false],
    ['ga', [FLAG], true, false, false, 'available', false, false],
    ['beta', [], false, false, false, 'beta', false, false],
    ['beta', [FLAG], true, false, false, 'beta', false, false],
    ['ga', [FLAG], false, true, false, 'beta', false, true],
    ['beta', [FLAG], false, true, false, 'beta', false, true],
    ['ga', [FLAG], false, false, false, 'coming-soon', false, false],
    ['beta', [FLAG], false, false, false, 'coming-soon', false, false],
    ['planned', [], false, false, false, 'coming-soon', false, false],
    ['planned', [], false, true, false, 'coming-soon', false, false],
    ['ga', [], false, false, true, 'connected', false, false],
    ['beta', [], false, false, true, 'connected', true, false],
    ['ga', [FLAG], false, true, true, 'connected', true, true],
    ['planned', [], false, false, true, 'coming-soon', false, false],
  ] as const)(
    '%s, flags %j, on=%s, admin=%s, connected=%s -> %s (beta tag %s, admin only %s)',
    (stage, flags, flagOn, isAdmin, connected, status, betaTag, adminOnly) => {
      expect(deriveStatus({ stage, flags }, context(flagOn ? flags : [], isAdmin), connected)).toEqual({
        status,
        betaTag,
        adminOnly,
      });
    }
  );
});

describe('isSettingChainOn', () => {
  it('is off when a dependsOn parent is off, even with the child on', () => {
    expect(isSettingChainOn('EnableDataLakeGitHub', key => key === 'EnableDataLakeGitHub')).toBe(false);
    expect(isSettingChainOn('EnableDataLakeGitHub', key => key !== 'EnableDataLakes')).toBe(false);
  });

  it('is on when the child and every parent are on', () => {
    expect(isSettingChainOn('EnableDataLakeGitHub', () => true)).toBe(true);
    expect(isSettingChainOn('EnableMCPServer', key => key === 'EnableMCPServer')).toBe(true);
  });
});

const entry = (id: keyof typeof INTEGRATION_CATALOG): Integration => ({ id, ...INTEGRATION_CATALOG[id] });

describe('deriveIntegrationStatus', () => {
  it('takes the best capability: GitHub is Available while repo sync is only Beta', () => {
    const derived = deriveIntegrationStatus(
      entry('github'),
      context(['EnableMCPServer', 'EnableDataLakes', 'EnableDataLakeGitHub'])
    );
    expect(derived.status).toBe('available');
    expect(derived.capabilities.map(c => [c.capability.id, c.status])).toEqual([
      ['github-tools', 'available'],
      ['github-lake', 'beta'],
      ['github-webhooks', 'available'],
    ]);
  });

  it("hides a flagged-off capability from non-admins without hiding the entry's other ones", () => {
    const derived = deriveIntegrationStatus(entry('github'), context([]));
    expect(derived.status).toBe('available');
    expect(derived.capabilities.map(c => c.status)).toEqual(['coming-soon', 'coming-soon', 'available']);
  });

  it('applies the entry flag to every capability', () => {
    expect(deriveIntegrationStatus(entry('linkedin'), context(['EnableMCPServer'])).status).toBe('beta');
    expect(deriveIntegrationStatus(entry('linkedin'), context([])).status).toBe('coming-soon');
    expect(deriveIntegrationStatus(entry('linkedin'), context([], true))).toMatchObject({
      status: 'beta',
      adminOnly: true,
    });
  });

  it('marks an entry admin-only only when nothing about it is visible to everyone', () => {
    const notion = entry('notion');
    expect(deriveIntegrationStatus(notion, context([], true))).toMatchObject({ status: 'beta', adminOnly: true });
    expect(deriveIntegrationStatus(notion, context(['EnableMCPServer'], true))).toMatchObject({
      status: 'available',
      adminOnly: false,
    });
  });

  it('lets Connected win the status slot and keeps the Beta tag', () => {
    expect(deriveIntegrationStatus(entry('linkedin'), context(['EnableMCPServer']), true)).toMatchObject({
      status: 'connected',
      betaTag: true,
    });
    expect(deriveIntegrationStatus(entry('notion'), context(['EnableMCPServer']), true)).toMatchObject({
      status: 'connected',
      betaTag: false,
    });
  });

  it('keeps planned entries Coming soon for everyone, connected or not', () => {
    expect(deriveIntegrationStatus(entry('hubspot'), context([], true), true).status).toBe('coming-soon');
    expect(deriveIntegrationStatus(entry('hubspot'), context([])).status).toBe('coming-soon');
  });

  it('still shows a connected entry as Connected to a non-admin once its flag goes off, with no tag, while each capability reads as off', () => {
    for (const id of ['linkedin', 'notion'] as const) {
      const derived = deriveIntegrationStatus(entry(id), context([]), true);
      expect(derived).toMatchObject({ status: 'connected', betaTag: false, adminOnly: false });
      expect(derived.capabilities.every(c => c.status === 'coming-soon')).toBe(true);
    }
  });

  describe('a ga entry whose every capability sits behind a flag', () => {
    const gated: Integration = {
      ...entry('okta'),
      capabilities: [
        { id: 'gated-a', label: 'A', kind: 'sign-in', stage: 'ga', flag: 'EnableMCPServer' },
        { id: 'gated-b', label: 'B', kind: 'sign-in', stage: 'ga', flag: 'EnableDataLakes' },
      ],
    };

    it('is admin-only Beta for an admin and Coming soon for everyone else while the flags are off', () => {
      const asAdmin = deriveIntegrationStatus(gated, context([], true));
      expect(asAdmin).toMatchObject({ status: 'beta', betaTag: false, adminOnly: true });
      expect(asAdmin.capabilities.every(c => c.status === 'beta' && c.adminOnly)).toBe(true);

      const asUser = deriveIntegrationStatus(gated, context([]));
      expect(asUser).toMatchObject({ status: 'coming-soon', adminOnly: false });
      expect(asUser.capabilities.every(c => c.status === 'coming-soon' && !c.adminOnly)).toBe(true);
    });

    it('keeps the admin-only note and a Beta tag on a connected admin', () => {
      expect(deriveIntegrationStatus(gated, context([], true), true)).toMatchObject({
        status: 'connected',
        betaTag: true,
        adminOnly: true,
      });
    });

    it('drops the admin-only note as soon as one capability is on for everyone', () => {
      const derived = deriveIntegrationStatus(gated, context(['EnableDataLakes'], true));
      expect(derived).toMatchObject({ status: 'available', adminOnly: false });
      expect(derived.capabilities.map(c => [c.capability.id, c.status, c.adminOnly])).toEqual([
        ['gated-a', 'beta', true],
        ['gated-b', 'available', false],
      ]);
    });
  });
});
