// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigHistoryEntrySchema,
  ConfigHistoryResponseSchema,
  ListProposalsResponseSchema,
  ResearchConfigResponseSchema,
  ResearchRunResponseSchema,
  UndoConfigChangeResponseSchema,
  type IDataLakeProposalDocument,
  type IDataLakeResearchConfigDocument,
  type IDataLakeResearchRunDocument,
  type LakeConfigHistoryEntry,
  type LakeConfigHistoryView,
} from '@bike4mind/common';
import { dataLakeResearchService } from '@bike4mind/services';
import {
  RESEARCH_ERROR_PREFIXES,
  classifyFailureReason,
  toPublicConfig,
  toPublicConfigHistory,
  toPublicProposal,
  toPublicUndoResult,
  toPublicRun,
} from './toPublicResearch';

const USER_ID = '65a0000000000000000000aa';
const OTHER_USER_ID = '65a0000000000000000000bb';
const REPO_ROOT = resolve(__dirname, '../../../..');

const config = (overrides: Partial<IDataLakeResearchConfigDocument> = {}): IDataLakeResearchConfigDocument =>
  ({
    id: 'cfg1',
    dataLakeId: 'lake1',
    name: 'Weekly sweep',
    trigger: 'periodic',
    cadence: 'daily',
    reviewBacklogLimit: 25,
    nextRunAt: new Date('2026-03-02T00:00:00.000Z'),
    lastRunAt: null,
    createdByUserId: USER_ID,
    source: 'search',
    feedUrl: null,
    query: 'coastal erosion',
    maxResults: 10,
    maxProposals: 5,
    trustedDomains: [],
    reviewDomains: [],
    unlistedSources: 'review',
    autoAdmitTrusted: false,
    maxAutoAdmits: 3,
    allowedDomains: [],
    blockedDomains: [],
    minRelevance: 0.6,
    costCeilingMicroUsd: 50_000,
    proposedTags: [],
    itemRules: [],
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as IDataLakeResearchConfigDocument;

const run = (overrides: Partial<IDataLakeResearchRunDocument> = {}): IDataLakeResearchRunDocument =>
  ({
    id: 'run1',
    dataLakeId: 'lake1',
    configId: 'cfg1',
    trigger: 'on_demand',
    status: 'completed',
    startedByUserId: USER_ID,
    startedAt: new Date('2026-03-01T00:00:00.000Z'),
    completedAt: new Date('2026-03-01T00:01:00.000Z'),
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    spentMicroUsd: 1200,
    levers: {
      source: 'search',
      feedUrl: null,
      query: 'coastal erosion',
      maxResults: 10,
      maxProposals: 5,
      trustedDomains: [],
      reviewDomains: [],
      unlistedSources: 'review',
      allowedDomains: [],
      blockedDomains: [],
      minRelevance: 0.6,
      costCeilingMicroUsd: 50_000,
      proposedTags: [],
      itemRules: [],
    },
    totals: { searchHits: 9, proposed: 2 },
    ...overrides,
  }) as unknown as IDataLakeResearchRunDocument;

const proposal = (overrides: Partial<IDataLakeProposalDocument> = {}): IDataLakeProposalDocument =>
  ({
    id: 'prop1',
    dataLakeId: 'lake1',
    status: 'pending',
    sourceUrl: 'https://example.com/a',
    canonicalSourceKey: 'https://example.com/a',
    title: 'A report',
    excerpt: 'text',
    textHash: 'h',
    proposedTags: ['x'],
    confidence: 0.7,
    rationale: 'why',
    provenance: { producer: 'research_run', runId: 'run1', retrievedAt: new Date('2026-03-01T00:00:00.000Z') },
    reviewedByUserId: USER_ID,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    ...overrides,
  }) as unknown as IDataLakeProposalDocument;

describe('classifyFailureReason', () => {
  const PROVIDER_TEXT = ' sk-live-abc123 request body echoed by the provider';
  const cases: Array<[string, string]> = [
    [RESEARCH_ERROR_PREFIXES.lakeMissing, 'no longer exists'],
    [RESEARCH_ERROR_PREFIXES.ownerCannotRun, 'cannot run research'],
    [RESEARCH_ERROR_PREFIXES.searchNotConfigured, 'not configured'],
    [RESEARCH_ERROR_PREFIXES.queueFailed, 'could not be queued'],
    [`${RESEARCH_ERROR_PREFIXES.judge}gpt-x) failed:`, 'relevance judge failed'],
    [RESEARCH_ERROR_PREFIXES.spendFrozen, 'Spending is paused'],
    ...RESEARCH_ERROR_PREFIXES.feed.map((prefix): [string, string] => [prefix, 'feed could not be read']),
    ['MongoServerError: connection reset', 'failed unexpectedly'],
  ];

  it.each(cases)('maps the producer prefix %j to fixed text and never copies provider text', (prefix, expected) => {
    const text = classifyFailureReason(`${prefix}${PROVIDER_TEXT}`);
    expect(text).toContain(expected);
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('echoed');
  });

  it('gives an absent error the unexpected-failure text', () => {
    expect(classifyFailureReason(null)).toContain('failed unexpectedly');
    expect(classifyFailureReason(undefined)).toContain('failed unexpectedly');
  });
});

describe('producer prefixes still exist at their source', () => {
  const read = (path: string) => readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const worker = read('apps/workers/src/dataLakes/runLakeResearch.ts');
  const queue = read('packages/server-utils/src/dataLakes/queueResearchRun.ts');
  const executor = read('b4m-core/services/src/dataLakeResearchService/executeResearchRun.ts');
  const credits = read('b4m-core/common/src/insufficientCredits.ts');

  it.each([
    ['lakeMissing', RESEARCH_ERROR_PREFIXES.lakeMissing, worker],
    ['ownerCannotRun', RESEARCH_ERROR_PREFIXES.ownerCannotRun, worker],
    ['searchNotConfigured', RESEARCH_ERROR_PREFIXES.searchNotConfigured, worker],
    ['queueFailed', RESEARCH_ERROR_PREFIXES.queueFailed, queue],
    ['judge', RESEARCH_ERROR_PREFIXES.judge, worker],
    ['spendFrozen', RESEARCH_ERROR_PREFIXES.spendFrozen, credits],
    ['feed[0]', RESEARCH_ERROR_PREFIXES.feed[0], executor],
    ['feed[1]', RESEARCH_ERROR_PREFIXES.feed[1], executor],
    ['feed[2]', RESEARCH_ERROR_PREFIXES.feed[2], worker],
    ['feed[3]', RESEARCH_ERROR_PREFIXES.feed[3], worker],
    ['feed[4]', RESEARCH_ERROR_PREFIXES.feed[4], worker],
  ])('%s', (_name, prefix, source) => {
    // The mapper matches with startsWith, so the prefix must open a string literal at the source.
    expect(["'", '"', '`'].some(quote => source.includes(`${quote}${prefix}`))).toBe(true);
  });
});

describe('toPublicRun', () => {
  it('sets failure_reason only on a failed run, from the classified text', () => {
    const failed = toPublicRun(run({ status: 'failed', error: `${RESEARCH_ERROR_PREFIXES.judge}m) failed: boom` }));
    expect(failed.failure_reason).toContain('relevance judge failed');
    expect(failed.judge_warning).toBeNull();
    expect(toPublicRun(run({ status: 'completed' })).failure_reason).toBeNull();
    expect(toPublicRun(run({ status: 'running', error: 'x' })).failure_reason).toBeNull();
  });

  it('sets judge_warning only on a completed run whose error carries the judge prefix', () => {
    const warned = toPublicRun(run({ status: 'completed', error: `${RESEARCH_ERROR_PREFIXES.judge}m) failed: boom` }));
    expect(warned.judge_warning).toContain('relevance judge failed on some candidates');
    expect(warned.failure_reason).toBeNull();
    expect(warned.judge_warning).not.toContain('boom');
    expect(toPublicRun(run({ status: 'completed', error: 'unrelated' })).judge_warning).toBeNull();
  });

  it('reports unlisted_dropped as null for a run stored before the split, and the number otherwise', () => {
    expect(toPublicRun(run()).totals.unlisted_dropped).toBeNull();
    expect(toPublicRun(run({ totals: { unlistedDropped: 0 } as never })).totals.unlisted_dropped).toBe(0);
    expect(toPublicRun(run({ totals: { unlistedDropped: 4 } as never })).totals.unlisted_dropped).toBe(4);
  });

  it('defaults absent counters to zero and satisfies the response schema', () => {
    const mapped = toPublicRun(run());
    expect(mapped.totals.not_judged).toBe(0);
    expect(ResearchRunResponseSchema.safeParse({ data: mapped }).success).toBe(true);
  });

  it('publishes no user id', () => {
    expect(JSON.stringify(toPublicRun(run()))).not.toContain(USER_ID);
  });
});

describe('toPublicConfig', () => {
  it('maps held to the scheduler rule: active schedule and backlog at or over the limit', () => {
    expect(toPublicConfig(config(), 25).held).toBe(true);
    expect(toPublicConfig(config(), 24).held).toBe(false);
    expect(toPublicConfig(config({ schedulePaused: true }), 99).held).toBe(false);
    expect(toPublicConfig(config({ cadence: 'off', trigger: 'on_demand' }), 99).held).toBe(false);
  });

  it('maps each scheduled outcome', () => {
    const at = new Date('2026-03-01T00:00:00.000Z');
    const started = toPublicConfig(config({ lastScheduledOutcome: { outcome: 'started', at, runId: 'run9' } }), 0);
    expect(started.last_scheduled_outcome).toMatchObject({ outcome: 'started', run_id: 'run9', error: null });

    const held = toPublicConfig(
      config({
        lastScheduledOutcome: {
          outcome: 'skipped',
          at,
          reason: 'review_backlog',
          pendingProposals: 30,
          reviewBacklogLimit: 25,
        },
      }),
      30
    );
    expect(held.last_scheduled_outcome).toMatchObject({
      outcome: 'skipped',
      reason: 'review_backlog',
      pending_proposals: 30,
      review_backlog_limit: 25,
    });

    const failed = toPublicConfig(
      config({ lastScheduledOutcome: { outcome: 'failed', at, error: 'MongoServerError: secret detail' } as never }),
      0
    );
    expect(failed.last_scheduled_outcome?.error).toBe(dataLakeResearchService.SCHEDULED_START_FAILED_MESSAGE);
    expect(JSON.stringify(failed)).not.toContain('secret detail');
  });

  it('drops a schedule_paused outcome once the schedule is running again, and keeps it while paused', () => {
    const at = new Date('2026-03-01T00:00:00.000Z');
    const outcome = { outcome: 'skipped', at, reason: 'schedule_paused' } as never;
    expect(
      toPublicConfig(config({ schedulePaused: false, lastScheduledOutcome: outcome }), 0).last_scheduled_outcome
    ).toBeNull();
    expect(
      toPublicConfig(config({ schedulePaused: true, lastScheduledOutcome: outcome }), 0).last_scheduled_outcome
    ).toMatchObject({ reason: 'schedule_paused' });
  });

  it('carries schedule_paused, never the feed cursor or the creator id, and satisfies the schema', () => {
    const mapped = toPublicConfig(config({ schedulePaused: true, feedCursor: { etag: 'e', seen: ['a'] } } as never), 0);
    expect(mapped.schedule_paused).toBe(true);
    const text = JSON.stringify(mapped);
    expect(text).not.toMatch(/feedCursor|feed_cursor|etag/);
    expect(text).not.toContain(USER_ID);
    expect(ResearchConfigResponseSchema.safeParse({ data: mapped }).success).toBe(true);
  });
});

describe('toPublicProposal', () => {
  it('omits the reviewer id and canonical key, and satisfies the list schema', () => {
    const mapped = toPublicProposal(proposal());
    const text = JSON.stringify(mapped);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain('canonical');
    expect(ListProposalsResponseSchema.safeParse({ data: [mapped], next_cursor: null }).success).toBe(true);
  });
});

describe('toPublicConfigHistory', () => {
  const view = {
    lakeId: 'lake1',
    lakeName: 'Handbook',
    entries: [
      {
        kind: 'config',
        eventId: 'ev1',
        changedAt: new Date('2026-03-01T00:00:00.000Z'),
        principalKind: 'user',
        principalId: USER_ID,
        principalName: 'Casey',
        manageRung: 'creator',
        action: 'update',
        onBehalfOfUserId: OTHER_USER_ID,
        changes: [
          { field: 'effectiveOwnerUserId', kind: 'literal', before: USER_ID, after: OTHER_USER_ID },
          {
            field: 'accessGrant',
            kind: 'literal',
            after: `user:${USER_ID}=curator`,
            before: `user:${'c'.repeat(24)}=read`,
          },
          { field: 'name', kind: 'literal', before: 'a', after: 'b' },
          {
            field: 'effectiveOwnerUserId',
            kind: 'literal',
            before: `${USER_ID},${OTHER_USER_ID}`,
            after: `${USER_ID},${USER_ID}`,
          },
        ],
      },
    ],
    userNames: { [USER_ID]: 'Casey' },
    truncated: false,
    windowStartsAt: new Date('2026-02-01T00:00:00.000Z'),
    generatedAt: new Date('2026-03-02T00:00:00.000Z'),
  } as unknown as LakeConfigHistoryView;

  it('replaces every user id with a display name, or "unknown user" when none resolves', () => {
    const mapped = toPublicConfigHistory(view);
    const text = JSON.stringify(mapped);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain(OTHER_USER_ID);
    const [owner, grant, name] = mapped.data.entries[0].changes;
    expect(owner).toMatchObject({ before: 'Casey', after: 'unknown user' });
    expect(grant).toMatchObject({ after: 'user:Casey=curator', before: 'user:unknown user=read' });
    expect(name).toMatchObject({ before: 'a', after: 'b' });
    expect(mapped.data.entries[0].changes[3]).toMatchObject({
      before: 'Casey, unknown user',
      after: 'Casey, Casey',
    });
    expect(ConfigHistoryResponseSchema.safeParse(mapped).success).toBe(true);
  });

  it('requires a target on a file row', () => {
    const fileRow = {
      kind: 'file',
      event_id: 'ev3',
      changed_at: '2026-03-01T00:00:00.000Z',
      principal_kind: 'user',
      principal_name: 'Casey',
      undoable: false,
      undone_by_event_id: null,
      file_name: null,
      action: 'file-added',
      origin: 'person',
    };
    expect(ConfigHistoryEntrySchema.safeParse(fileRow).success).toBe(false);
    expect(ConfigHistoryEntrySchema.safeParse({ ...fileRow, target: { kind: 'file', id: 'fab1' } }).success).toBe(true);
  });

  const withEntries = (entries: unknown[]) => ({ ...view, entries }) as unknown as LakeConfigHistoryView;

  it('maps a config entry with target, lever_changes and the admitted file in snake_case', () => {
    const mapped = toPublicConfigHistory(
      withEntries([
        {
          kind: 'config',
          eventId: 'ev2',
          changedAt: new Date('2026-03-01T00:00:00.000Z'),
          principalKind: 'user',
          principalId: USER_ID,
          manageRung: 'creator',
          action: 'approve-proposal',
          changes: [],
          target: { kind: 'proposal', id: 'p1' },
          leverChanges: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }],
          admittedFabFileId: 'fab1',
        },
      ])
    );
    expect(mapped.data.entries[0]).toMatchObject({
      kind: 'config',
      target: { kind: 'proposal', id: 'p1' },
      lever_changes: [{ lever: 'minRelevance', before: 0.6, after: 0.5 }],
      admitted_fab_file_id: 'fab1',
    });
    expect(ConfigHistoryResponseSchema.safeParse(mapped).success).toBe(true);
  });

  it('omits the new keys on an old config row', () => {
    const entry = toPublicConfigHistory(view).data.entries[0] as Record<string, unknown>;
    expect(entry.kind).toBe('config');
    for (const key of ['target', 'lever_changes', 'admitted_fab_file_id']) expect(key in entry).toBe(false);
  });

  it('maps a file entry without a rung or changes, and never exposes the principal id', () => {
    const mapped = toPublicConfigHistory(
      withEntries([
        {
          kind: 'file',
          eventId: 'ev3',
          changedAt: new Date('2026-03-02T00:00:00.000Z'),
          principalKind: 'user',
          principalId: USER_ID,
          principalName: 'Casey',
          action: 'file-removed',
          target: { kind: 'file', id: 'fab7' },
          origin: 'person',
          undoesEventId: 'ev0',
        },
      ])
    );
    const entry = mapped.data.entries[0];
    expect(entry).toEqual({
      kind: 'file',
      event_id: 'ev3',
      changed_at: '2026-03-02T00:00:00.000Z',
      principal_kind: 'user',
      principal_name: 'Casey',
      undoable: false,
      undone_by_event_id: null,
      target: { kind: 'file', id: 'fab7' },
      file_name: null,
      action: 'file-removed',
      origin: 'person',
      undoes_event_id: 'ev0',
    });
    expect(JSON.stringify(mapped)).not.toContain(USER_ID);
    expect(ConfigHistoryResponseSchema.safeParse(mapped).success).toBe(true);
  });

  it('exposes undoable, undone_by_event_id and file_name, and nothing else from the undo facts', () => {
    const mapped = toPublicConfigHistory(
      withEntries([
        {
          kind: 'file',
          eventId: 'ev5',
          changedAt: new Date('2026-03-02T00:00:00.000Z'),
          principalKind: 'user',
          principalId: USER_ID,
          action: 'file-added',
          target: { kind: 'file', id: 'fab7' },
          fileName: 'handbook.pdf',
          origin: 'person',
          undoable: true,
          undone: false,
          undoNote: 'internal note',
        },
        {
          kind: 'config',
          eventId: 'ev6',
          changedAt: new Date('2026-03-02T00:00:00.000Z'),
          principalKind: 'user',
          principalId: USER_ID,
          manageRung: 'creator',
          action: 'update-research-config',
          changes: [],
          undoable: false,
          undone: true,
          undoneByEventId: 'ev7',
        },
      ])
    );
    expect(mapped.data.entries[0]).toMatchObject({
      undoable: true,
      undone_by_event_id: null,
      file_name: 'handbook.pdf',
    });
    expect(mapped.data.entries[1]).toMatchObject({ undoable: false, undone_by_event_id: 'ev7' });
    expect(JSON.stringify(mapped)).not.toMatch(/undoNote|internal note|"undone"|fileName|undoneBy/);
    expect(JSON.stringify(mapped)).not.toContain(USER_ID);
    expect(ConfigHistoryResponseSchema.safeParse(mapped).success).toBe(true);
  });

  it('maps an undo result, and a null entry when the History write did not persist', () => {
    const row = {
      kind: 'config',
      eventId: 'ev8',
      changedAt: new Date('2026-03-02T00:00:00.000Z'),
      principalKind: 'user',
      principalId: USER_ID,
      manageRung: 'creator',
      action: 'update-research-config',
      changes: [],
      undoable: true,
      undoesEventId: 'ev1',
    } as unknown as LakeConfigHistoryEntry;
    const mapped = toPublicUndoResult({ entry: row, notes: ['on hold'] });
    expect(mapped).toMatchObject({ data: { event_id: 'ev8', undoable: true }, notes: ['on hold'] });
    expect(JSON.stringify(mapped)).not.toContain(USER_ID);
    expect(UndoConfigChangeResponseSchema.safeParse(mapped).success).toBe(true);
    expect(toPublicUndoResult({ entry: null, notes: [] })).toEqual({ data: null, notes: [] });
  });

  it('puts no feed query string on the wire when the stored lever change is redacted', () => {
    const mapped = toPublicConfigHistory(
      withEntries([
        {
          kind: 'config',
          eventId: 'ev4',
          changedAt: new Date('2026-03-01T00:00:00.000Z'),
          principalKind: 'user',
          principalId: USER_ID,
          manageRung: 'creator',
          action: 'update-research-config',
          changes: [],
          leverChanges: [{ lever: 'feedUrl', before: 'https://example.com/a.xml', after: 'https://example.com/b.xml' }],
        },
      ])
    );
    expect(JSON.stringify(mapped)).not.toContain('?');
  });
});
