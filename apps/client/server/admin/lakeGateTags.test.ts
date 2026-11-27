// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@bike4mind/common';

const findGateValues = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ dataLakeRepository: { findGateValues } }));

import { assertCanChangeLakeGateTags, lakeGateTagsIn } from './lakeGateTags';

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
    await expect(lakeGateTagsIn(['opti', 'optihashi:pro'])).resolves.toEqual(['opti', 'optihashi:pro']);
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
