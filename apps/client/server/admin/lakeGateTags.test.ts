// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DATA_LAKES, ForbiddenError } from '@bike4mind/common';

const findGateValues = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: { findGateValues } }));

import { assertCanChangeLakeGateTags, assertCanChangeLakeGateTagsBetween, lakeGateTagsIn } from './lakeGateTags';

const delegate = { isAdmin: false, adminPermissions: ['settings:manage'] };
const fullAdmin = { isAdmin: true };

beforeEach(() => {
  findGateValues.mockReset();
  findGateValues.mockResolvedValue({ userTags: ['Partner-Beta'], entitlements: ['acme:pro'] });
});

describe('lakeGateTagsIn', () => {
  it('matches a stored requiredUserTag trimmed and case-folded', async () => {
    await expect(lakeGateTagsIn([' partner-beta ', 'pilot'])).resolves.toEqual([' partner-beta ']);
  });

  it('matches a tag that grants a stored requiredEntitlement', async () => {
    await expect(lakeGateTagsIn(['ACME:Pro'])).resolves.toEqual(['ACME:Pro']);
  });

  it('matches the gates of registry lakes', async () => {
    findGateValues.mockResolvedValue({ userTags: [], entitlements: [] });
    const registryGates = DATA_LAKES.flatMap(lake => [lake.requiredUserTag, lake.requiredEntitlement]).filter(
      (gate): gate is string => !!gate
    );
    expect(registryGates.length).toBeGreaterThan(0);
    await expect(lakeGateTagsIn(registryGates)).resolves.toEqual(registryGates);
  });

  it('skips the lookup when no tags are given', async () => {
    await expect(lakeGateTagsIn([])).resolves.toEqual([]);
    expect(findGateValues).not.toHaveBeenCalled();
  });
});

describe('assertCanChangeLakeGateTags', () => {
  it('refuses a lake gate tag from a delegated admin', async () => {
    await expect(assertCanChangeLakeGateTags(delegate, ['pilot', 'Partner-Beta'])).rejects.toThrow(ForbiddenError);
  });

  it('allows ordinary tags for a delegated admin', async () => {
    await expect(assertCanChangeLakeGateTags(delegate, ['pilot'])).resolves.toBeUndefined();
  });

  it('allows a lake gate tag for a full admin without a lookup', async () => {
    await expect(assertCanChangeLakeGateTags(fullAdmin, ['Partner-Beta'])).resolves.toBeUndefined();
    expect(findGateValues).not.toHaveBeenCalled();
  });
});

describe('assertCanChangeLakeGateTagsBetween', () => {
  it('treats a re-spelled lake gate tag as a change', async () => {
    await expect(
      assertCanChangeLakeGateTagsBetween(delegate, [' partner-beta ', 'old'], ['partner-beta', 'old'])
    ).rejects.toThrow(ForbiddenError);
  });

  it('allows a delegate to keep a lake gate tag spelled exactly as stored', async () => {
    await expect(
      assertCanChangeLakeGateTagsBetween(delegate, ['Partner-Beta', 'old'], ['Partner-Beta', 'pilot'])
    ).resolves.toBeUndefined();
  });
});
