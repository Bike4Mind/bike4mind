import { describe, expect, it, vi } from 'vitest';
import type { LakeMembershipMemberRow } from '@bike4mind/common';
import {
  detectAdmissionDuplicates,
  type AdmissionDuplicateCandidate,
  type DetectAdmissionDuplicatesAdapters,
} from './detectAdmissionDuplicates';

const LAKE = {
  id: 'lake-1',
  name: 'Acme Policies',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};

let seq = 0;
const sibling = (over: Partial<LakeMembershipMemberRow> = {}): LakeMembershipMemberRow => ({
  fabFileId: `s${++seq}`,
  fileName: 'policy.md',
  serverTextHash: 'aaa',
  fileSize: 100,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  userId: 'creator-1',
  arm: 'meta-tag',
  relativePath: null,
  driveFileId: null,
  ...over,
});

const candidate = (over: Partial<AdmissionDuplicateCandidate> = {}): AdmissionDuplicateCandidate => ({
  id: 'incoming-1',
  userId: 'creator-1',
  fileName: 'policy.md',
  serverTextHash: 'aaa',
  fileSize: 100,
  createdAt: new Date('2026-03-01T00:00:00Z'),
  tags: [{ name: 'datalake:acme' }],
  ...over,
});

type LakeFixture = typeof LAKE;

/**
 * The adapters bag plus its spies on one object. The two repository methods are typed from the
 * interface the service actually asks for, so a widened signature there fails this file rather than
 * being absorbed by a cast.
 */
const adapters = (siblings: LakeMembershipMemberRow[] = [], lakes: LakeFixture[] = [LAKE]) => {
  const findLakeMemberSiblingsByFileName = vi.fn<
    DetectAdmissionDuplicatesAdapters['db']['fabFiles']['findLakeMemberSiblingsByFileName']
  >(async () => siblings);
  const findByDatalakeTag = vi.fn(async (tag: string) => lakes.find(l => l.datalakeTag === tag) ?? null);
  const find = vi.fn(async () => lakes);
  const warn = vi.fn();
  return {
    // The two lake reads are narrowed by `findMemberLakesForFile` to the fields it uses, so a lake
    // fixture carrying five of them is a legitimate stand-in for IDataLakeDocument here.
    db: {
      dataLakes: { find, findByDatalakeTag } as unknown as DetectAdmissionDuplicatesAdapters['db']['dataLakes'],
      fabFiles: { findLakeMemberSiblingsByFileName },
    },
    logger: { warn },
    findLakeMemberSiblingsByFileName,
    findByDatalakeTag,
    find,
    warn,
  };
};

describe('detectAdmissionDuplicates', () => {
  it('reports the lake in which an admitted file duplicates a member', async () => {
    const a = adapters([sibling({ fabFileId: 'existing-1' })]);

    const findings = await detectAdmissionDuplicates(candidate(), a);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ lakeId: 'lake-1', lakeName: 'Acme Policies', tier: 'fileName' });
    // The group carries the admitted member too: the ruling is stamped over the whole group.
    expect(findings[0].group.members.map(m => m.fabFileId)).toEqual(['incoming-1', 'existing-1']);
  });

  it('reads nothing at all for a nameless file', async () => {
    const a = adapters([sibling()]);

    expect(await detectAdmissionDuplicates(candidate({ fileName: null }), a)).toEqual([]);
    expect(a.findByDatalakeTag).not.toHaveBeenCalled();
    expect(a.find).not.toHaveBeenCalled();
    expect(a.findLakeMemberSiblingsByFileName).not.toHaveBeenCalled();
  });

  it('reads no siblings for a file that belongs to no lake', async () => {
    const a = adapters([sibling()], []);

    expect(await detectAdmissionDuplicates(candidate({ tags: [] }), a)).toEqual([]);
    expect(a.findLakeMemberSiblingsByFileName).not.toHaveBeenCalled();
  });

  it('queries one lake per membership, scoped so the prefix arm still matches', async () => {
    const a = adapters([]);

    await detectAdmissionDuplicates(candidate(), a);

    expect(a.findLakeMemberSiblingsByFileName).toHaveBeenCalledWith(
      // Dropping creatorUserId here would silently narrow the check to meta-tagged members, on
      // lakes whose members are largely prefix-only.
      { kind: 'owned', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'creator-1' },
      'policy.md',
      'incoming-1',
      50
    );
  });

  it('reports nothing when the shared name is the only thing shared', async () => {
    // Two unrelated `policy.md` under different folders - the false pair the file-name tier makes.
    const a = adapters([sibling({ relativePath: 'archive/' })]);

    expect(await detectAdmissionDuplicates(candidate({ relativePath: 'legal/' }), a)).toEqual([]);
    expect(a.warn).not.toHaveBeenCalled();
  });

  it('logs the finding by id and tier, never by file or lake name', async () => {
    const a = adapters([sibling({ fabFileId: 'existing-1' })]);

    await detectAdmissionDuplicates(candidate(), a);

    const [line] = a.warn.mock.calls[0];
    expect(line).toContain('lake-1');
    expect(line).toContain('existing-1');
    expect(line).toContain('matched by fileName');
    // Both are content a lake's users chose; this line reaches the ingestion logs.
    expect(line).not.toContain('policy.md');
    expect(line).not.toContain('Acme Policies');
  });

  it('grades the candidate by the arm it actually reaches the lake through', async () => {
    // A prefix-only member: no `datalake:*` tag, admitted by the lake's content-tag prefix.
    const a = adapters([sibling({ arm: 'prefix' })]);

    const findings = await detectAdmissionDuplicates(candidate({ tags: [{ name: 'acme:legal' }] }), a);

    expect(findings[0].group.members.find(m => m.fabFileId === 'incoming-1')?.arm).toBe('prefix');
  });

  it('reports every lake the duplicate lands in', async () => {
    const second = { ...LAKE, id: 'lake-2', name: 'Shared', datalakeTag: 'datalake:shared' };
    const a = adapters([sibling()], [LAKE, second]);

    const findings = await detectAdmissionDuplicates(
      candidate({ tags: [{ name: 'datalake:acme' }, { name: 'datalake:shared' }] }),
      a
    );

    expect(findings.map(f => f.lakeId)).toEqual(['lake-1', 'lake-2']);
  });

  it('survives a caller with no logger', async () => {
    const a = adapters([sibling()]);
    const findings = await detectAdmissionDuplicates(candidate(), { db: a.db });

    expect(findings).toHaveLength(1);
  });
});
