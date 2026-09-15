import { describe, expect, it } from 'vitest';
import type { FabFileChunkPolicyConflict, LakeMembershipMemberInput } from '@bike4mind/common';
import { FabFileSourceType } from '@bike4mind/common';
import {
  admissionDoorLabel,
  computeServerTextHash,
  describeSameIdentityAdmission,
  detectSameIdentityAdmission,
  deriveAdmissionStatus,
  normalizeTextForHash,
} from './admissionContract';

describe('normalizeTextForHash', () => {
  it('collapses every run of whitespace to a single space and trims', () => {
    expect(normalizeTextForHash('  a\t\tb\n\n c  ')).toBe('a b c');
  });

  it('normalizes to NFC so canonically-equivalent forms compare equal', () => {
    const composed = 'caf\u00e9'; // precomposed 'e-acute' (already NFC)
    const decomposed = 'cafe\u0301'; // 'e' + combining acute (NFD form)
    expect(decomposed).not.toBe(composed);
    expect(normalizeTextForHash(decomposed)).toBe(normalizeTextForHash(composed));
  });

  it('reduces text that is only whitespace to the empty string', () => {
    expect(normalizeTextForHash('  \n\t  ')).toBe('');
  });
});

describe('computeServerTextHash', () => {
  it('is deterministic for the same extracted text', () => {
    const a = computeServerTextHash('hello world');
    const b = computeServerTextHash('hello world');
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores insignificant whitespace differences (a "materially changed" signal, not byte identity)', () => {
    // Same words, different line wrapping / spacing - e.g. two extractions of the same document.
    const wrapped = computeServerTextHash('the quick brown fox jumps');
    const reflowed = computeServerTextHash('the   quick\nbrown   fox\n\njumps  ');
    expect(wrapped).toBe(reflowed);
  });

  it('changes when the text materially changes', () => {
    expect(computeServerTextHash('the quick brown fox')).not.toBe(computeServerTextHash('the quick red fox'));
  });

  it('returns undefined for text-less input rather than hashing the empty string', () => {
    // A hashed empty string would collide across every extraction that yields no text.
    expect(computeServerTextHash(undefined)).toBeUndefined();
    expect(computeServerTextHash('')).toBeUndefined();
    expect(computeServerTextHash('  \n\t ')).toBeUndefined();
  });
});

describe('deriveAdmissionStatus', () => {
  const conflict: FabFileChunkPolicyConflict = {
    effectiveTarget: 512,
    embeddingModel: 'text-embedding-3-small',
    lakes: [],
    detectedAt: new Date(),
  };

  it('is admitted when there is no unresolved chunk-policy conflict', () => {
    expect(deriveAdmissionStatus(null)).toBe('admitted');
  });

  it('is quarantined when the member cannot honor an applicable lake policy', () => {
    expect(deriveAdmissionStatus(conflict)).toBe('quarantined');
  });
});

describe('admissionDoorLabel', () => {
  it('renders the stamped source type', () => {
    expect(admissionDoorLabel(FabFileSourceType.GOOGLE_DRIVE)).toBe('google_drive');
    expect(admissionDoorLabel(FabFileSourceType.MANUAL_UPLOAD)).toBe('manual_upload');
  });

  it('falls back to unknown when a door left provenance unset', () => {
    expect(admissionDoorLabel(undefined)).toBe('unknown');
  });
});

describe('detectSameIdentityAdmission', () => {
  let seq = 0;
  const memberOf = (over: Partial<LakeMembershipMemberInput> = {}): LakeMembershipMemberInput => ({
    fabFileId: `f${++seq}`,
    fileName: 'policy.md',
    arm: 'meta-tag',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    fileSize: 100,
    serverTextHash: 'aaa',
    ...over,
  });

  it('RECORDS a same-identity admission and never rejects it', () => {
    // The report-only property, pinned: this returns a finding, and there is no throwing or
    // refusing path for a caller to reach. A same-named upload is very often a legitimate revision,
    // so a gate here would have blocked the corrected copies this whole lane came from.
    const incoming = memberOf({ createdAt: new Date('2026-03-01T00:00:00Z') });
    const existing = memberOf();

    const found = detectSameIdentityAdmission(incoming, [existing]);

    expect(found).not.toBeNull();
    expect(found?.tier).toBe('fileName');
    expect(found?.group.fileName).toBe('policy.md');
    // The admitted member is IN the group, newest first: the ruling is stamped over the whole group.
    expect(found?.group.members.map(m => m.fabFileId)).toEqual([incoming.fabFileId, existing.fabFileId]);
    expect(found?.group.memberCount).toBe(2);
  });

  it('grades identity confidence the same way the membership report does', () => {
    const identical = detectSameIdentityAdmission(memberOf(), [memberOf()]);
    expect(identical?.group.bucket).toBe('proven-identical');

    // A REVISION: same source, different text. The case a hash could never catch, and the reason
    // the key is path identity.
    const revised = detectSameIdentityAdmission(memberOf({ serverTextHash: 'bbb' }), [memberOf()]);
    expect(revised?.group.bucket).toBe('differing');

    const unverified = detectSameIdentityAdmission(memberOf({ serverTextHash: null }), [memberOf()]);
    expect(unverified?.group.bucket).toBe('unverified');
  });

  it('offers nothing when no sibling shares the name', () => {
    expect(detectSameIdentityAdmission(memberOf(), [])).toBeNull();
    expect(detectSameIdentityAdmission(memberOf(), [memberOf({ fileName: 'other.md' })])).toBeNull();
  });

  it('offers nothing when the shared name is the ONLY thing shared', () => {
    // Two unrelated `policy.md` under different folders. This is the false pair the bare file-name
    // tier produces, and offering to collapse it is the one error this check cannot afford.
    const incoming = memberOf({ relativePath: 'legal/', createdAt: new Date('2026-03-01T00:00:00Z') });
    const unrelated = memberOf({ relativePath: 'archive/' });

    expect(detectSameIdentityAdmission(incoming, [unrelated])).toBeNull();
  });

  it('offers nothing for a nameless member, which can match nobody', () => {
    expect(detectSameIdentityAdmission(memberOf({ fileName: undefined }), [memberOf()])).toBeNull();
  });

  it('reports the driveFileId tier for two copies of one Drive document', () => {
    const incoming = memberOf({
      fileName: 'policy-v3.md',
      driveFileId: 'd1',
      createdAt: new Date('2026-03-01T00:00:00Z'),
    });
    const existing = memberOf({ fileName: 'policy-v3.md', driveFileId: 'd1' });

    const found = detectSameIdentityAdmission(incoming, [existing]);

    expect(found?.tier).toBe('driveFileId');
    expect(found?.group.memberCount).toBe(2);
  });

  it('does NOT match a Drive file across a rename, unlike the retrieval-time collapse', () => {
    // A stable `driveFileId` is not enough here, and that is deliberate rather than a gap.
    // `buildDuplicateGroups` keys the OUTER group on the exact file name because a ruling is stored
    // against (dataLakeId, fileName), so two names cannot share one tombstone key - which means the
    // driveFileId tier can only ever SPLIT a same-name group, never join two generations filed under
    // different names. `partitionBySupersession` does no name grouping and so does match across a
    // rename (see sourceIdentity.test.ts); the two surfaces genuinely differ here, and the previous
    // version of this test claimed the opposite while giving both fixtures the same name.
    const renamed = memberOf({
      fileName: 'policy-v4.md',
      driveFileId: 'd1',
      createdAt: new Date('2026-04-01T00:00:00Z'),
    });
    const existing = memberOf({ fileName: 'policy-v3.md', driveFileId: 'd1' });

    expect(detectSameIdentityAdmission(renamed, [existing])).toBeNull();
  });

  it('describes a finding by id and tier, never by file name', () => {
    const incoming = memberOf({ createdAt: new Date('2026-03-01T00:00:00Z') });
    const found = detectSameIdentityAdmission(incoming, [memberOf()])!;

    const line = describeSameIdentityAdmission('lake-1', found);

    expect(line).toContain('lake-1');
    expect(line).toContain('matched by fileName');
    expect(line).toContain(incoming.fabFileId);
    // The name is uploader content and this line reaches the ingestion logs.
    expect(line).not.toContain('policy.md');
  });
});
