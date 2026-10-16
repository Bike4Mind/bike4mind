import { describe, it, expect, vi, beforeEach } from 'vitest';

// The gate's two-arm lake resolution is unit-tested beside its source (prefixArmMembership.test.ts);
// here the shared service is the seam, so only findOtherLakeClaims is stubbed. hasOtherLakeClaim is
// the real one-liner (mirrored) so the verdict is read from the same shape the service returns.
const h = vi.hoisted(() => ({ findOtherLakeClaims: vi.fn() }));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    findOtherLakeClaims: h.findOtherLakeClaims,
    hasOtherLakeClaim: (claims: { metaTagNames: string[]; prefixArmLakes: unknown[] }) =>
      claims.metaTagNames.length > 0 || claims.prefixArmLakes.length > 0,
  },
}));

import { evaluateConnectorCopyDeletion } from './connectorCopyGate';

type GateFile = Parameters<typeof evaluateConnectorCopyDeletion>[0];
type GateDeps = Parameters<typeof evaluateConnectorCopyDeletion>[2];

const lake = { id: 'lake1', datalakeTag: 'datalake:lake1' };
const adapters: GateDeps['adapters'] = { db: { dataLakes: {} as never }, candidateLakes: [] };
const ownerExists = async () => true;

const baseFile = (over: Partial<GateFile> = {}): GateFile => ({
  id: 'ff1',
  userId: 'u1',
  users: [],
  groups: [],
  isGlobalRead: false,
  tags: [],
  ...over,
});

const evaluate = (copy: GateFile, deps: Partial<GateDeps> = {}) =>
  evaluateConnectorCopyDeletion(copy, lake, { adapters, ownerStillExists: ownerExists, ...deps });

describe('evaluateConnectorCopyDeletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: [], prefixArmLakes: [] });
  });

  it.each([
    ['a direct user share', { users: [{ userId: 'bob', permissions: 'read' }] }],
    ['a group share', { groups: [{ groupId: 'g1', permissions: 'read' }] }],
    ['isGlobalRead', { isGlobalRead: true }],
  ])('refuses a copy carrying %s', async (_label, share) => {
    const verdict = await evaluate(baseFile(share as Partial<GateFile>));
    expect(verdict.deletable).toBe(false);
    if (!verdict.deletable) expect(verdict.reason).toBe('shared');
    // A share is refused before any lake lookup.
    expect(h.findOtherLakeClaims).not.toHaveBeenCalled();
  });

  it('clears a copy whose share arrays are present but EMPTY', async () => {
    const verdict = await evaluate(baseFile({ users: [], groups: [], isGlobalRead: false }));
    expect(verdict).toEqual({ deletable: true, ownerId: 'u1' });
  });

  it('refuses a copy another lake holds by meta-tag', async () => {
    h.findOtherLakeClaims.mockResolvedValue({ metaTagNames: ['datalake:handbuilt-b'], prefixArmLakes: [] });
    const verdict = await evaluate(baseFile());
    expect(verdict.deletable).toBe(false);
    if (!verdict.deletable) {
      expect(verdict.reason).toBe('other-lake');
      expect(verdict.detail).toEqual({ otherLakeTags: ['datalake:handbuilt-b'], otherLakeIds: [] });
    }
  });

  it('refuses a copy another lake holds by PREFIX arm (no meta-tag)', async () => {
    h.findOtherLakeClaims.mockResolvedValue({
      metaTagNames: [],
      prefixArmLakes: [{ id: 'lake-b', createdByUserId: 'u1', fileTagPrefix: 'acme:' }],
    });
    const verdict = await evaluate(baseFile({ tags: [{ name: 'acme:q3', strength: 1 }] }));
    expect(verdict.deletable).toBe(false);
    if (!verdict.deletable) {
      expect(verdict.reason).toBe('other-lake');
      expect(verdict.detail).toEqual({ otherLakeTags: [], otherLakeIds: ['lake-b'] });
    }
  });

  it('refuses a copy with no owner id', async () => {
    const verdict = await evaluate(baseFile({ userId: undefined }));
    expect(verdict.deletable).toBe(false);
    if (!verdict.deletable) expect(verdict.reason).toBe('no-owner');
  });

  it('refuses a copy whose owner no longer exists', async () => {
    const verdict = await evaluate(baseFile({ userId: 'gone' }), { ownerStillExists: async () => false });
    expect(verdict.deletable).toBe(false);
    if (!verdict.deletable) {
      expect(verdict.reason).toBe('no-owner');
      expect(verdict.detail).toEqual({ ownerId: 'gone' });
    }
  });

  it('clears a sole-owner copy and returns its owner', async () => {
    const verdict = await evaluate(baseFile());
    expect(verdict).toEqual({ deletable: true, ownerId: 'u1' });
  });

  it('asks with the post-unpick tags and the row owner, and threads the candidate lakes through', async () => {
    const candidateLakes = [{ id: 'lake-b', createdByUserId: 'u1', fileTagPrefix: 'acme:' }];
    await evaluate(baseFile({ tags: [{ name: 'acme:q3', strength: 1 }] }), {
      adapters: { db: { dataLakes: {} as never }, candidateLakes },
    });
    expect(h.findOtherLakeClaims).toHaveBeenCalledWith(
      { userId: 'u1', tagNames: ['acme:q3'] },
      lake,
      expect.objectContaining({ candidateLakes })
    );
  });
});
