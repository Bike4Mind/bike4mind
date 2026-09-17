import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { getAccessibleDataLakePrompts } from './getDataLakePrompts';
import type { DataLakeAccessContext } from './getDynamicDataLakeTags';

/**
 * Prompt INJECTION writes a lake's `systemPrompt` into the caller's turn, so its trust rule is the
 * strictest of the three creator-provenance arms - and it was the same bare provenance as the other
 * two: `isTrustedForInjection` returned true for `createdByUserId === userId`, and
 * `createdByUserId` is immutable. A creator transferred or departed off a lake therefore kept its
 * instructions in their system prompt indefinitely.
 *
 * The lake below is GATELESS on purpose: a gated one is dropped by `lakeMatchesAccess` before trust
 * is ever consulted, which would make these tests pass without exercising the arm they are about.
 * Gateless and org-less means the creator arm is the ONLY thing that can make it trusted, so the
 * assertions isolate it. The repo mock over-returns (it ignores the exclusion it is handed) for the
 * same reason as on the retrieval side - the in-memory rule is the subject here.
 */

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'mine',
    slug: 'mine',
    name: 'Mine',
    fileTagPrefix: 'mine:',
    datalakeTag: 'datalake:mine',
    createdByUserId: 'alice',
    status: 'active',
    systemPrompt: 'Prefer the 2026 revision.',
    ...overrides,
  }) as IDataLakeDocument;

const ctx = (lakes: IDataLakeDocument[], ownerOfMine: string) => {
  const findActiveByUserTagsAndEntitlements = vi.fn().mockResolvedValue(lakes);
  const context = {
    db: {
      dataLakes: {
        findActiveByUserTagsAndEntitlements,
        findById: vi.fn().mockResolvedValue(null),
        findIdsCreatedBy: vi.fn().mockResolvedValue(['mine']),
      },
      organizations: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
      dataLakeAccessGrants: {
        listByPrincipal: vi.fn().mockResolvedValue([]),
        listActiveByLakes: vi
          .fn()
          .mockResolvedValue([{ dataLakeId: 'mine', principalType: 'user', principalId: ownerOfMine, role: 'owner' }]),
      },
      adminSettings: { getSettingsValue: vi.fn().mockResolvedValue(false) },
    },
    user: { id: 'alice', tags: [] },
  } as unknown as DataLakeAccessContext;
  return { context, findActiveByUserTagsAndEntitlements };
};

describe('prompt injection - a creator superseded as owner stops injecting the lake prompt', () => {
  it('injects the prompt while the caller is still the effective owner', async () => {
    const { context } = ctx([lake()], 'alice');

    const prompts = await getAccessibleDataLakePrompts(context);

    expect(prompts.map(p => p.id)).toEqual(['mine']);
  });

  it('withholds it once an owner grant has moved ownership off the creator', async () => {
    const { context } = ctx([lake()], 'billing-owner');

    const prompts = await getAccessibleDataLakePrompts(context);

    expect(prompts).toEqual([]);
  });

  it('hands the exclusion to the datastore pre-filter too', async () => {
    const { context, findActiveByUserTagsAndEntitlements } = ctx([lake()], 'billing-owner');

    await getAccessibleDataLakePrompts(context);

    expect(findActiveByUserTagsAndEntitlements).toHaveBeenCalledWith(
      [],
      [],
      [],
      'alice',
      expect.objectContaining({ supersededOwnLakeIds: ['mine'] })
    );
  });

  it('degrades OPEN when the supersession read throws, without dropping the grant arm', async () => {
    const { context } = ctx([lake()], 'billing-owner');
    (context.db.dataLakes!.findIdsCreatedBy as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ns not found'));

    const prompts = await getAccessibleDataLakePrompts(context);

    expect(prompts.map(p => p.id)).toEqual(['mine']);
  });
});
