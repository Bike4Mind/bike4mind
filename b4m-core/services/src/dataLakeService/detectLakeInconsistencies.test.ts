import { describe, it, expect, vi } from 'vitest';
import {
  detectLakeInconsistencies,
  INCONSISTENCY_CHUNKS_PER_MEMBER,
  INCONSISTENCY_DETECTOR,
  INCONSISTENCY_MEMBER_SAMPLE,
} from './detectLakeInconsistencies';

const lake = {
  id: 'lake1',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'u1',
};

type MemberRow = {
  fabFileId: string;
  fileName?: string;
  serverTextHash: string | null;
  fileSize: number | null;
  createdAt: Date | null;
  arm: 'meta-tag' | 'prefix';
};

const memberRow = (fabFileId: string, fileName = `${fabFileId}.pdf`): MemberRow => ({
  fabFileId,
  fileName,
  serverTextHash: null,
  fileSize: 1,
  createdAt: null,
  arm: 'meta-tag',
});

type DismissedKey = { kind: string; subject: string };

const makeAdapters = (
  members: MemberRow[],
  textsById: Record<string, string[]> = {},
  dismissed: DismissedKey[] = []
) => {
  const findChunkTextSample = vi.fn(async (fabFileId: string) => textsById[fabFileId] ?? []);
  return {
    db: {
      fabFiles: { findDataLakeMembershipMembers: vi.fn(async () => members) },
      fabFileChunks: { findChunkTextSample },
      dataLakeFindings: { listDismissedKeys: vi.fn(async () => dismissed) },
    },
    logger: { warn: vi.fn() },
  };
};

describe('detectLakeInconsistencies', () => {
  it('finds a disagreement spanning two members', async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], {
      a: ['Uptime is 99.9%'],
      b: ['Uptime is 99.5%'],
    });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].kind).toBe('metric-disagreement');
    expect(report.findings[0].evidence.map(e => e.fabFileId).sort()).toEqual(['a', 'b']);
  });

  it('reads chunk text BOUNDED per member, never the whole file', async () => {
    // The reason this pass exists outside computeLakeHealth: it touches the chunk collection, which
    // #1665 measured as ruinous to scan. The bound is the thing that makes it acceptable at all.
    const adapters = makeAdapters([memberRow('a')], { a: ['text'] });

    await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(adapters.db.fabFileChunks.findChunkTextSample).toHaveBeenCalledWith('a', INCONSISTENCY_CHUNKS_PER_MEMBER);
  });

  it('bounds the member scan and reports the result as a lower bound', async () => {
    const tooMany = Array.from({ length: INCONSISTENCY_MEMBER_SAMPLE + 1 }, (_, i) => memberRow(`f${i}`));
    const adapters = makeAdapters(tooMany);

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.memberSampled).toBe(true);
    expect(adapters.db.fabFileChunks.findChunkTextSample).toHaveBeenCalledTimes(INCONSISTENCY_MEMBER_SAMPLE);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('memberSampled'));
  });

  it('reports sampled on every run, because it never reads a member whole', async () => {
    // It used to be derived from member overflow alone, so a small lake reported sampled:false -
    // "counts are exact" - about a pass that had read five chunks per document. An owner seeing
    // {findingCount: 0, sampled: false} reasonably concluded the corpus was read and is clean.
    const { report } = await detectLakeInconsistencies(lake, 2026, makeAdapters([memberRow('a')]) as never);

    expect(report.sampled).toBe(true);
    expect(report.memberSampled).toBe(false);
  });

  it('reports a lake it never scanned as memberCount 0 rather than as an empty clean report', async () => {
    const { report } = await detectLakeInconsistencies(
      { ...lake, datalakeTag: '' } as never,
      2026,
      makeAdapters([memberRow('a')]) as never
    );

    expect(report.memberCount).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('counts the members it read text for, so 0 distinguishes "scanned nothing" from "clean"', async () => {
    // The zero case above is the only one that was asserted, and hardcoding memberCount to 0 fails
    // nothing without this. The field exists to tell those two apart, and this is the other half.
    //
    // It counts members that yielded TEXT, not members matched: 'd' has no chunk sample and is not
    // counted, which is the distinction an owner reading {findingCount: 0} needs.
    const adapters = makeAdapters([memberRow('a'), memberRow('b'), memberRow('c'), memberRow('d')], {
      a: ['Uptime is 99.9%'],
      b: ['Uptime is 99.9%'],
      c: ['Uptime is 99.9%'],
    });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.memberCount).toBe(3);
    expect(report.findings).toEqual([]);
  });

  it('isolates an unreadable member instead of failing the whole report', async () => {
    // A report is worth more partial than not at all, and the omission is logged rather than silent.
    const adapters = makeAdapters([memberRow('bad'), memberRow('a'), memberRow('b')], {
      a: ['Uptime is 99.9%'],
      b: ['Uptime is 99.5%'],
    });
    adapters.db.fabFileChunks.findChunkTextSample.mockImplementation(async (fabFileId: string) => {
      if (fabFileId === 'bad') throw new Error('chunk read failed');
      return fabFileId === 'a' ? ['Uptime is 99.9%'] : ['Uptime is 99.5%'];
    });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
    expect(adapters.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not read chunk text'));
  });

  it('never scans on a null datalakeTag - this returns document excerpts', async () => {
    // Same guard as computeLakeHealth's, and it matters more here: a degraded membership match would
    // put other tenants' document TEXT into this response.
    const adapters = makeAdapters([memberRow('a')], { a: ['Uptime is 99.9%'] });

    const { report } = await detectLakeInconsistencies({ ...lake, datalakeTag: '' }, 2026, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).not.toHaveBeenCalled();
    expect(adapters.db.fabFileChunks.findChunkTextSample).not.toHaveBeenCalled();
    expect(report.findings).toEqual([]);
  });

  it('drops a member with no chunk text rather than carrying an empty document', async () => {
    const adapters = makeAdapters([memberRow('empty'), memberRow('a')], { a: ['Supported until 2020.'] });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].evidence[0].fabFileId).toBe('a');
  });

  it("joins a member's sampled chunks so a claim spanning two passages is still seen", async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], {
      a: ['Some preamble.', 'Uptime is 99.9%'],
      b: ['Uptime is 99.5%'],
    });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
  });

  it('takes the year from the caller, so a stored report stays comparable', async () => {
    const adapters = makeAdapters([memberRow('a')], { a: ['Expected in 2025.'] });

    expect((await detectLakeInconsistencies(lake, 2024, adapters as never)).report.findings).toEqual([]);
    expect((await detectLakeInconsistencies(lake, 2026, adapters as never)).report.findings).toHaveLength(1);
  });

  it('scopes the member read to this lake', async () => {
    const adapters = makeAdapters([]);

    await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(adapters.db.fabFiles.findDataLakeMembershipMembers).toHaveBeenCalledWith(
      expect.objectContaining({ datalakeTag: 'datalake:acme', creatorUserId: 'u1' }),
      INCONSISTENCY_MEMBER_SAMPLE
    );
  });
});

describe('detectLakeInconsistencies dismissal suppression (#3045)', () => {
  const twoMembers = { a: ['Uptime is 99.9%'], b: ['Uptime is 99.5%'] };

  it('does not resurrect a finding a curator dismissed', async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], twoMembers, [
      { kind: 'metric-disagreement', subject: 'uptime' },
    ]);

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(0);
    // The counts feed the health summary, so leaving the dismissal in them would resurrect it there
    // even with the finding itself gone from the list.
    expect(report.countsByKind['metric-disagreement']).toBe(0);
    expect(report.truncated).toBe(false);
  });

  it('hands the suppressed finding back so its row can stay current', async () => {
    // A dismissal keys on kind and subject, so the passages under it can change into a worse
    // contradiction. Dropping the finding entirely would freeze the row at the original excerpts and
    // leave that change visible nowhere at all.
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], twoMembers, [
      { kind: 'metric-disagreement', subject: 'uptime' },
    ]);

    const { suppressed } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].subject).toBe('uptime');
    expect(suppressed[0].evidence.map(e => e.fabFileId).sort()).toEqual(['a', 'b']);
  });

  it('still reports when the dismissal read fails, rather than costing the run its report', async () => {
    // Failing closed would 500 a ~1000-chunk pass that the corpus could have answered. Failing open
    // re-reports one dismissal, which a curator dismisses again.
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], twoMembers);
    adapters.db.dataLakeFindings.listDismissedKeys = vi.fn(async () => {
      throw new Error('findings unavailable');
    });

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
    expect(adapters.logger.warn).toHaveBeenCalled();
  });

  it("keys the suppression on the lake and this pass's detector", async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], twoMembers);

    await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(adapters.db.dataLakeFindings.listDismissedKeys).toHaveBeenCalledWith('lake1', INCONSISTENCY_DETECTOR);
  });

  it('leaves a finding dismissed under a DIFFERENT subject alone', async () => {
    const adapters = makeAdapters([memberRow('a'), memberRow('b')], twoMembers, [
      { kind: 'metric-disagreement', subject: 'latency' },
    ]);

    const { report } = await detectLakeInconsistencies(lake, 2026, adapters as never);

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].subject).toBe('uptime');
  });

  it('never reads dismissals for a lake it refuses to scan', async () => {
    // The null-tag guard returns before any collection is touched; a dismissal read there would be
    // a query issued for a report that is empty by construction.
    const adapters = makeAdapters([memberRow('a')], { a: ['Uptime is 99.9%'] });

    await detectLakeInconsistencies({ ...lake, datalakeTag: '' }, 2026, adapters as never);

    expect(adapters.db.dataLakeFindings.listDismissedKeys).not.toHaveBeenCalled();
  });
});
