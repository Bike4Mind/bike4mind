import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictError } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { undoLakeConfigChange, type UndoActions, type UndoLakeConfigChangeAdapters } from './undoLakeConfigChange';
import { classifyConfigUndo, classifyFileUndo } from './lakeChangeUndoability';

const LAKE = { id: 'lake-1' };
const hex = (n: number) => n.toString(16).padStart(24, '0');
const NOW = new Date('2026-06-10T12:00:00Z');
const T = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

type Row = Record<string, unknown> & { id: string; dataLakeId: string; createdAt: Date };

const matches = (row: Row, filter: Record<string, unknown>): boolean =>
  Object.entries(filter).every(([key, want]) => {
    const have =
      key === '_id' ? row.id : key === 'target.id' ? (row.target as { id?: string } | undefined)?.id : row[key];
    if (want && typeof want === 'object' && !(want instanceof Date)) {
      const ops = want as Record<string, unknown>;
      if ('$ne' in ops && have === ops.$ne) return false;
      if ('$gte' in ops && !((have as Date) >= (ops.$gte as Date))) return false;
      return true;
    }
    return have === want;
  });

interface World {
  config: Row[];
  file: Row[];
  claims: Set<string>;
  claimOrder: string[];
  configs: Record<string, unknown>[];
  proposals: Record<string, unknown>[];
  snapshots: Record<string, unknown>;
  removals: Set<string>;
  pending: number;
}

function setup(over: Partial<World> = {}) {
  const world: World = {
    config: [],
    file: [],
    claims: new Set(),
    claimOrder: [],
    configs: [],
    proposals: [],
    snapshots: {},
    removals: new Set(),
    pending: 0,
    ...over,
  };
  const actions: { [K in keyof UndoActions]: ReturnType<typeof vi.fn> } = {
    updateResearchConfig: vi.fn(async () => undefined),
    setSchedulePaused: vi.fn(async () => undefined),
    createResearchConfig: vi.fn(async () => undefined),
    deleteResearchConfig: vi.fn(async () => undefined),
    declineProposal: vi.fn(async () => undefined),
    restoreProposal: vi.fn(async () => undefined),
    unapproveProposal: vi.fn(async () => undefined),
    removeFile: vi.fn(async () => undefined),
    addFile: vi.fn(async () => undefined),
  };
  const adapters: UndoLakeConfigChangeAdapters = {
    db: {
      lakeConfigChangeEvents: {
        findOne: vi.fn(async (f: Record<string, unknown>) => world.config.find(r => matches(r, f)) ?? null),
        count: vi.fn(async (f: Record<string, unknown>) => world.config.filter(r => matches(r, f)).length),
      } as never,
      lakeMembershipChangeEvents: {
        findOne: vi.fn(async (f: Record<string, unknown>) => world.file.find(r => matches(r, f)) ?? null),
        count: vi.fn(async (f: Record<string, unknown>) => world.file.filter(r => matches(r, f)).length),
      } as never,
      lakeConfigUndoClaims: {
        claim: vi.fn(async (lakeId: string, eventId: string) => {
          const key = `${lakeId}:${eventId}`;
          if (world.claims.has(key)) return false;
          world.claims.add(key);
          world.claimOrder.push(key);
          return true;
        }),
        release: vi.fn(async (lakeId: string, eventId: string) => {
          world.claims.delete(`${lakeId}:${eventId}`);
        }),
      },
      lakeConfigSnapshots: {
        findLive: vi.fn(async (_l: string, eventId: string) => (world.snapshots[eventId] as never) ?? null),
      },
      lakeMembershipRemovals: {
        findLive: vi.fn(async (_l: string, fileId: string) => (world.removals.has(fileId) ? ({} as never) : null)),
      },
      dataLakeResearchConfigs: {
        findByIdInLake: vi.fn(async (id: string) => (world.configs.find(c => c.id === id) as never) ?? null),
        listByLake: vi.fn(async () => world.configs as never),
      },
      dataLakeProposals: {
        findById: vi.fn(async (id: string) => (world.proposals.find(p => p.id === id) as never) ?? null),
        countPendingByLakes: vi.fn(async () => ({ [LAKE.id]: world.pending })),
      },
    },
    actions: actions as never,
    now: NOW,
  };
  return { world, actions, adapters };
}

const configEvent = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: hex(n),
  dataLakeId: LAKE.id,
  createdAt: T(60 - n),
  action: 'update-research-config',
  target: { kind: 'researchConfig', id: 'cfg-1' },
  ...over,
});

const fileEvent = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: hex(n),
  dataLakeId: LAKE.id,
  createdAt: T(60 - n),
  fabFileId: 'file-1',
  action: 'added',
  origin: 'person',
  principalKind: 'user',
  principalId: 'u1',
  ...over,
});

const researchConfig = (over: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  dataLakeId: LAKE.id,
  name: 'Sweep',
  query: 'q',
  cadence: 'off',
  schedulePaused: false,
  reviewBacklogLimit: 20,
  source: 'search',
  feedUrl: null,
  maxResults: 10,
  maxProposals: 5,
  trustedDomains: ['a.com', 'b.com'],
  reviewDomains: [],
  unlistedSources: 'review',
  autoAdmitTrusted: false,
  maxAutoAdmits: 3,
  blockedDomains: [],
  minRelevance: 0.5,
  costCeilingMicroUsd: 1000,
  proposedTags: [],
  itemRules: [],
  ...over,
});

describe('undoLakeConfigChange', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  describe('binding and claims', () => {
    it('404s an event id from another lake, and a malformed one', async () => {
      ctx.world.config.push(configEvent(1, { dataLakeId: 'other-lake' }));
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(NotFoundError);
      await expect(undoLakeConfigChange('not-an-id', LAKE, ctx.adapters)).rejects.toBeInstanceOf(NotFoundError);
      expect(ctx.adapters.db.lakeConfigUndoClaims.claim).not.toHaveBeenCalled();
    });

    it('applies once when two undos of one event race', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig());

      const results = await Promise.allSettled([
        undoLakeConfigChange(hex(1), LAKE, ctx.adapters),
        undoLakeConfigChange(hex(1), LAKE, ctx.adapters),
      ]);

      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictError);
      expect(rejected.reason.message).toBe('Already undone');
      expect(ctx.actions.updateResearchConfig).toHaveBeenCalledTimes(1);
    });

    it('refuses a second undo of the same event', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig());
      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('Already undone');
    });

    it('refuses a row that has no inverse, without taking a claim', async () => {
      ctx.world.config.push(configEvent(1, { action: 'visibility', target: undefined }));
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.adapters.db.lakeConfigUndoClaims.claim).not.toHaveBeenCalled();
    });

    it('links the inverse action to the event it reverses, under a pre-minted row id', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig());

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      const [, , audit] = ctx.actions.updateResearchConfig.mock.calls[0];
      expect(audit.undoesEventId).toBe(hex(1));
      expect(audit.eventId).toMatch(/^[0-9a-f]{24}$/);
      expect([...ctx.world.claims]).toEqual([`lake-1:${hex(1)}`]);
    });

    it('returns a null entry, not a failure, when the undo row did not persist', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig());
      const result = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);
      expect(result.entry).toBeNull();
      expect(result.notes).toEqual([]);
    });
  });

  describe('lever changes', () => {
    it('restores every before value in one call', async () => {
      ctx.world.config.push(
        configEvent(1, {
          leverChanges: [
            { lever: 'minRelevance', before: 0.6, after: 0.5 },
            { lever: 'name', before: 'Old', after: 'Sweep' },
            { lever: 'maxResults', before: 20, after: 10 },
          ],
        })
      );
      ctx.world.configs.push(researchConfig());

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.updateResearchConfig).toHaveBeenCalledTimes(1);
      expect(ctx.actions.updateResearchConfig.mock.calls[0][1]).toEqual({
        minRelevance: 0.6,
        name: 'Old',
        maxResults: 20,
      });
    });

    it('refuses drift on a lever, naming the field and the current value', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig({ minRelevance: 0.8 }));

      const err = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters).catch(e => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toMatch(/min relevance.*now 0\.8/);
      expect(err.additionalInfo).toMatchObject({ field: 'minRelevance' });
      expect(ctx.actions.updateResearchConfig).not.toHaveBeenCalled();
      expect(ctx.world.claims.size).toBe(0);
    });

    it('does not read a reordered list as drift', async () => {
      ctx.world.config.push(
        configEvent(1, { leverChanges: [{ lever: 'trustedDomains', before: ['a.com'], after: ['b.com', 'a.com'] }] })
      );
      ctx.world.configs.push(researchConfig());

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).resolves.toBeDefined();
    });

    it('treats null and absent as the same value', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'recencyDays', before: 7, after: null }] }));
      ctx.world.configs.push(researchConfig());

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).resolves.toBeDefined();
    });

    it('turns a validation refusal into a 409 naming the blocking field and its current value', async () => {
      ctx.world.config.push(
        configEvent(1, { leverChanges: [{ lever: 'unlistedSources', before: 'drop', after: 'review' }] })
      );
      ctx.world.configs.push(researchConfig({ trustedDomains: [], reviewDomains: [] }));
      ctx.actions.updateResearchConfig.mockRejectedValueOnce(
        new BadRequestError('List at least one site to review', { field: 'unlistedSources' })
      );

      const err = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters).catch(e => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.message).toMatch(/List at least one site/);
      expect(err.message).toMatch(/unlisted sources is now review/);
      expect(err.additionalInfo).toMatchObject({ field: 'unlistedSources' });
    });

    it('can be retried once the blocker is cleared, because a refusal releases the claim', async () => {
      ctx.world.config.push(
        configEvent(1, { leverChanges: [{ lever: 'unlistedSources', before: 'drop', after: 'review' }] })
      );
      ctx.world.configs.push(researchConfig());
      ctx.actions.updateResearchConfig.mockRejectedValueOnce(new BadRequestError('nope', { field: 'unlistedSources' }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).resolves.toBeDefined();
      expect(ctx.world.claims.size).toBe(1);
    });

    it('releases the claim when the action throws something else', async () => {
      ctx.world.config.push(configEvent(1, { leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }] }));
      ctx.world.configs.push(researchConfig());
      ctx.actions.updateResearchConfig.mockRejectedValueOnce(new Error('boom'));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('boom');
      expect(ctx.world.claims.size).toBe(0);
    });

    it('routes a pause-only change through the pause service', async () => {
      ctx.world.config.push(
        configEvent(1, { leverChanges: [{ lever: 'schedulePaused', before: false, after: true }] })
      );
      ctx.world.configs.push(researchConfig({ cadence: 'daily', schedulePaused: true }));

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.setSchedulePaused).toHaveBeenCalledWith('cfg-1', false, expect.anything());
      expect(ctx.actions.updateResearchConfig).not.toHaveBeenCalled();
    });

    it('restores the pause flag a cadence-off edit silently cleared', async () => {
      ctx.world.config.push(
        configEvent(1, {
          leverChanges: [
            { lever: 'schedulePaused', before: true, after: false },
            { lever: 'cadence', before: 'daily', after: 'off' },
          ],
        })
      );
      ctx.world.configs.push(researchConfig());

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.updateResearchConfig.mock.calls[0][1]).toEqual({ schedulePaused: true, cadence: 'daily' });
    });

    it('restores the full working feed address from the snapshot, never the redacted label', async () => {
      const before = 'https://example.com/old.xml?token=secret-old';
      const after = 'https://example.com/new.xml?token=secret-new';
      ctx.world.config.push(
        configEvent(1, {
          leverChanges: [
            { lever: 'feedUrl', before: 'https://example.com/old.xml', after: 'https://example.com/new.xml' },
          ],
        })
      );
      ctx.world.configs.push(researchConfig({ source: 'feed', feedUrl: after }));
      ctx.world.snapshots[hex(1)] = { kind: 'feed-url-edited', feedUrlBefore: before, feedUrlAfter: after };

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.updateResearchConfig.mock.calls[0][1]).toEqual({ feedUrl: before });
    });

    it('never puts a feed query string in a drift refusal', async () => {
      ctx.world.config.push(
        configEvent(1, {
          leverChanges: [
            { lever: 'feedUrl', before: 'https://example.com/old.xml', after: 'https://example.com/new.xml' },
          ],
        })
      );
      ctx.world.configs.push(
        researchConfig({ source: 'feed', feedUrl: 'https://example.com/third.xml?token=secret-third' })
      );
      ctx.world.snapshots[hex(1)] = {
        kind: 'feed-url-edited',
        feedUrlBefore: 'https://example.com/old.xml?token=secret-old',
        feedUrlAfter: 'https://example.com/new.xml?token=secret-new',
      };

      const err = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters).catch(e => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(JSON.stringify([err.message, err.additionalInfo])).not.toMatch(/secret|token/);
    });

    it('refuses a feed undo once the snapshot has expired', async () => {
      ctx.world.config.push(
        configEvent(1, { leverChanges: [{ lever: 'feedUrl', before: 'https://e.com/a', after: 'https://e.com/b' }] })
      );
      ctx.world.configs.push(researchConfig({ source: 'feed', feedUrl: 'https://e.com/b' }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('This change is too old to undo');
    });
  });

  describe('create and delete', () => {
    it('deletes the config a create made', async () => {
      ctx.world.config.push(configEvent(1, { action: 'create-research-config' }));
      ctx.world.configs.push(researchConfig());

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.deleteResearchConfig).toHaveBeenCalledWith(
        'cfg-1',
        expect.objectContaining({ undoesEventId: hex(1) })
      );
    });

    it('refuses to undo a create after a later edit', async () => {
      ctx.world.config.push(configEvent(1, { action: 'create-research-config' }));
      ctx.world.config.push(configEvent(2, { leverChanges: [{ lever: 'name', before: 'a', after: 'b' }] }));
      ctx.world.configs.push(researchConfig());

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.actions.deleteResearchConfig).not.toHaveBeenCalled();
      expect(ctx.world.claims.size).toBe(0);
    });

    const deleted = (config: Record<string, unknown>) => {
      ctx.world.config.push(configEvent(1, { action: 'delete-research-config', leverChanges: [], createdAt: T(10) }));
      ctx.world.snapshots[hex(1)] = { kind: 'config-deleted', config };
    };

    it('recreates a deleted config from its snapshot, paused when it was scheduled and paused', async () => {
      deleted(researchConfig({ cadence: 'daily', schedulePaused: true }));

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      const [input] = ctx.actions.createResearchConfig.mock.calls[0];
      expect(input).toMatchObject({ name: 'Sweep', cadence: 'daily', schedulePaused: true, query: 'q' });
      expect(input).not.toHaveProperty('allowedDomains');
    });

    it('does not send a pause for a config whose cadence is off', async () => {
      deleted(researchConfig({ cadence: 'off', schedulePaused: true }));

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.createResearchConfig.mock.calls[0][0]).not.toHaveProperty('schedulePaused');
    });

    it('refuses with 409 at the configuration cap', async () => {
      deleted(researchConfig());
      for (let i = 0; i < 20; i++) ctx.world.configs.push(researchConfig({ id: `c${i}` }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow(
        'This lake already has 20 research configurations'
      );
    });

    it('refuses after the snapshot expired', async () => {
      ctx.world.config.push(configEvent(1, { action: 'delete-research-config', leverChanges: [], createdAt: T(10) }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('This change is too old to undo');
    });

    it('names the failed check when the snapshot no longer passes validation', async () => {
      deleted(researchConfig());
      ctx.actions.createResearchConfig.mockRejectedValueOnce(
        new BadRequestError('A research configuration can have at most 10 item rules', { field: 'itemRules' })
      );

      const err = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters).catch(e => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.additionalInfo).toMatchObject({ field: 'itemRules' });
    });
  });

  describe('proposals', () => {
    const proposal = (status: string, over: Record<string, unknown> = {}) => ({
      id: 'p1',
      dataLakeId: LAKE.id,
      status,
      ...over,
    });

    it('unapproves an approved proposal and reports a backlog hold', async () => {
      ctx.world.config.push(
        configEvent(1, { action: 'approve-proposal', target: { kind: 'proposal', id: 'p1' }, admittedFabFileId: 'f1' })
      );
      ctx.world.proposals.push(proposal('approved'));
      ctx.world.configs.push(researchConfig({ cadence: 'daily', reviewBacklogLimit: 3 }));
      ctx.world.pending = 3;

      const result = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.unapproveProposal).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ undoesEventId: hex(1) }),
        'f1'
      );
      expect(result.notes).toHaveLength(1);
      expect(result.notes[0]).toMatch(/on hold for "Sweep"/);
    });

    it('reports no hold when the queue is below the limit', async () => {
      ctx.world.config.push(
        configEvent(1, { action: 'auto-approve-proposal', target: { kind: 'proposal', id: 'p1' } })
      );
      ctx.world.proposals.push(proposal('approved'));
      ctx.world.configs.push(researchConfig({ cadence: 'daily', reviewBacklogLimit: 20 }));
      ctx.world.pending = 1;

      expect((await undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).notes).toEqual([]);
    });

    it('refuses to unapprove a proposal that is no longer approved, or was ruled on again', async () => {
      ctx.world.config.push(configEvent(1, { action: 'approve-proposal', target: { kind: 'proposal', id: 'p1' } }));
      ctx.world.proposals.push(proposal('pending'));
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);

      ctx.world.proposals[0] = proposal('approved');
      ctx.world.config.push(configEvent(2, { action: 'decline-proposal', target: { kind: 'proposal', id: 'p1' } }));
      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.actions.unapproveProposal).not.toHaveBeenCalled();
    });

    describe('unapprove after file changes', () => {
      const approval = (over: Record<string, unknown> = {}) =>
        configEvent(1, {
          action: 'approve-proposal',
          target: { kind: 'proposal', id: 'p1' },
          admittedFabFileId: 'f1',
          ...over,
        });

      it('refuses when the approved file was added or removed after the approval', async () => {
        ctx.world.config.push(approval());
        ctx.world.proposals.push(proposal('approved'));
        ctx.world.file.push(fileEvent(2, { fabFileId: 'f1', action: 'removed' }));

        await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
        expect(ctx.actions.unapproveProposal).not.toHaveBeenCalled();
      });

      it('proceeds when a later file event is for a different file', async () => {
        ctx.world.config.push(approval());
        ctx.world.proposals.push(proposal('approved'));
        ctx.world.file.push(fileEvent(2, { fabFileId: 'other-file' }));

        await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

        expect(ctx.actions.unapproveProposal).toHaveBeenCalledWith('p1', expect.anything(), 'f1');
      });

      it('proceeds when the approval names no file', async () => {
        ctx.world.config.push(approval({ admittedFabFileId: undefined }));
        ctx.world.proposals.push(proposal('approved'));
        ctx.world.file.push(fileEvent(2, { fabFileId: 'f1' }));

        await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

        expect(ctx.actions.unapproveProposal).toHaveBeenCalled();
      });
    });

    it('refuses to restore a proposal that is no longer declined', async () => {
      ctx.world.config.push(configEvent(1, { action: 'decline-proposal', target: { kind: 'proposal', id: 'p1' } }));
      ctx.world.proposals.push(proposal('pending'));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.actions.restoreProposal).not.toHaveBeenCalled();
    });

    it('refuses to decline a proposal that is no longer pending', async () => {
      ctx.world.config.push(configEvent(1, { action: 'restore-proposal', target: { kind: 'proposal', id: 'p1' } }));
      ctx.world.proposals.push(proposal('approved'));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.actions.declineProposal).not.toHaveBeenCalled();
    });

    it('404s a proposal that belongs to another lake, before taking a claim', async () => {
      ctx.world.config.push(configEvent(1, { action: 'approve-proposal', target: { kind: 'proposal', id: 'p1' } }));
      ctx.world.proposals.push(proposal('approved', { dataLakeId: 'other' }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(NotFoundError);
      expect(ctx.adapters.db.lakeConfigUndoClaims.claim).not.toHaveBeenCalled();
    });

    it('restores a declined proposal, and declines a restored one', async () => {
      ctx.world.config.push(configEvent(1, { action: 'decline-proposal', target: { kind: 'proposal', id: 'p1' } }));
      ctx.world.proposals.push(proposal('declined'));
      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);
      expect(ctx.actions.restoreProposal).toHaveBeenCalledWith('p1', expect.anything());

      ctx.world.config.push(configEvent(2, { action: 'restore-proposal', target: { kind: 'proposal', id: 'p2' } }));
      ctx.world.proposals.push(proposal('pending', { id: 'p2' }));
      await undoLakeConfigChange(hex(2), LAKE, ctx.adapters);
      expect(ctx.actions.declineProposal).toHaveBeenCalledWith('p2', expect.anything());
    });
  });

  describe('files', () => {
    it('removes a file that was added', async () => {
      ctx.world.file.push(fileEvent(1));

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.removeFile).toHaveBeenCalledWith('file-1', expect.objectContaining({ undoesEventId: hex(1) }));
    });

    describe('result entry file name', () => {
      const FILE_ID = hex(77);
      const withFiles = (files: Record<string, unknown>[]) => {
        ctx.world.file.push(fileEvent(1, { action: 'removed', fabFileId: FILE_ID, createdAt: T(5) }));
        ctx.world.removals.add(FILE_ID);
        const findOne = ctx.adapters.db.lakeMembershipChangeEvents.findOne as ReturnType<typeof vi.fn>;
        const original = findOne.getMockImplementation()!;
        findOne.mockImplementation(async (f: Record<string, unknown>) =>
          f._id === hex(1) ? original(f) : fileEvent(2, { id: f._id, fabFileId: FILE_ID, createdAt: NOW })
        );
        ctx.adapters.db.fabFiles = { find: vi.fn(async () => files as never) };
      };

      it('names the file the undo re-added', async () => {
        withFiles([{ id: FILE_ID, fileName: 'report.pdf' }]);

        const result = await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

        expect(result.entry).toMatchObject({ kind: 'file', fileName: 'report.pdf' });
      });

      it('leaves the name off when the file no longer exists', async () => {
        withFiles([{ id: FILE_ID, fileName: 'report.pdf', deletedAt: new Date() }]);
        expect((await undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).entry).not.toHaveProperty('fileName');
      });
    });

    it('refuses to undo an add after the file was removed and re-added', async () => {
      ctx.world.file.push(fileEvent(1), fileEvent(2, { action: 'removed' }), fileEvent(3));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.actions.removeFile).not.toHaveBeenCalled();
    });

    it('maps a missing file on the inverse to a refusal', async () => {
      ctx.world.file.push(fileEvent(1));
      ctx.actions.removeFile.mockRejectedValueOnce(new NotFoundError('gone'));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
      expect(ctx.world.claims.size).toBe(0);
    });

    it('re-adds a removed file inside the restore window', async () => {
      ctx.world.file.push(fileEvent(1, { action: 'removed', createdAt: T(5) }));
      ctx.world.removals.add('file-1');

      await undoLakeConfigChange(hex(1), LAKE, ctx.adapters);

      expect(ctx.actions.addFile).toHaveBeenCalledWith('file-1', expect.objectContaining({ undoesEventId: hex(1) }));
    });

    it('tells the user to add the file again once the restore window has passed', async () => {
      ctx.world.file.push(fileEvent(1, { action: 'removed', createdAt: T(45) }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('Add it again from your files');
    });

    it('refuses when the restore record is gone though the row is recent', async () => {
      ctx.world.file.push(fileEvent(1, { action: 'removed', createdAt: T(5) }));

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toThrow('Add it again from your files');
      expect(ctx.world.claims.size).toBe(0);
    });

    it('gives the removal an unapprove caused no Undo of its own', async () => {
      ctx.world.file.push(fileEvent(1, { action: 'removed', causedByEventId: hex(9), createdAt: T(5) }));
      ctx.world.removals.add('file-1');

      await expect(undoLakeConfigChange(hex(1), LAKE, ctx.adapters)).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

describe('classifyConfigUndo / classifyFileUndo', () => {
  const base = { createdAt: T(5), undoesEventId: undefined, admittedFabFileId: undefined, leverChanges: undefined };

  it('gives old rows without a target no Undo', () => {
    expect(classifyConfigUndo({ ...base, action: 'update-research-config', target: undefined }, NOW)).toEqual({});
    expect(classifyConfigUndo({ ...base, action: 'approve-proposal', target: undefined }, NOW)).toEqual({});
  });

  it('gives lake-level and run actions no Undo', () => {
    for (const action of [
      'visibility',
      'grant-access',
      'transfer-ownership',
      'start-research-run',
      'complete-research-run',
    ] as const) {
      expect(
        classifyConfigUndo({ ...base, action, target: { kind: 'researchConfig', id: 'x' } }, NOW).plan
      ).toBeUndefined();
    }
  });

  it('points a recreate and an unapprove row at the place to redo them', () => {
    expect(
      classifyConfigUndo(
        { ...base, action: 'create-research-config', undoesEventId: 'e', target: { kind: 'researchConfig', id: 'x' } },
        NOW
      )
    ).toEqual({ note: 'Delete it from Research' });
    expect(
      classifyConfigUndo(
        {
          ...base,
          action: 'restore-proposal',
          undoesEventId: 'e',
          admittedFabFileId: 'f',
          target: { kind: 'proposal', id: 'p' },
        },
        NOW
      )
    ).toEqual({ note: 'Re-approve from Proposals' });
  });

  it('lets a lever undo row be undone in turn', () => {
    expect(
      classifyConfigUndo(
        {
          ...base,
          action: 'update-research-config',
          undoesEventId: 'e',
          leverChanges: [{ lever: 'name', before: 'a', after: 'b' }],
          target: { kind: 'researchConfig', id: 'x' },
        },
        NOW
      ).plan
    ).toBe('update-config');
  });

  it('expires the delete undo with the snapshot', () => {
    const old = {
      ...base,
      createdAt: new Date(NOW.getTime() - 31 * 86_400_000),
      action: 'delete-research-config' as const,
      leverChanges: [],
      target: { kind: 'researchConfig' as const, id: 'x' },
    };
    expect(classifyConfigUndo(old, NOW).plan).toBeUndefined();
    expect(classifyFileUndo({ action: 'added', causedByEventId: undefined, createdAt: T(9999) }, NOW).plan).toBe(
      'remove-file'
    );
  });
});
