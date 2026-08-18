import { describe, expect, it } from 'vitest';
import {
  filterPdfCandidates,
  planUploads,
  resolveLakeTarget,
  splitStalePending,
  type CandidateFile,
  type ExistingLakeDoc,
  type HashedCandidate,
} from './ingestPlan.js';

const candidate = (overrides: Partial<CandidateFile> = {}): CandidateFile => ({
  absPath: '/corpus/archive/vendor-a/2024/paper.pdf',
  relativePath: 'archive/vendor-a/2024/paper.pdf',
  fileName: 'paper.pdf',
  fileSize: 1_000_000,
  ...overrides,
});

const hashed = (overrides: Partial<HashedCandidate> = {}): HashedCandidate => ({
  ...candidate(),
  contentHash: 'hash-a',
  ...overrides,
});

const MAX = 20 * 1024 * 1024;

describe('filterPdfCandidates', () => {
  it('accepts pdf files regardless of extension case', () => {
    const result = filterPdfCandidates([candidate({ fileName: 'a.pdf' }), candidate({ fileName: 'B.PDF' })], MAX);
    expect(result.accepted.map(f => f.fileName)).toEqual(['a.pdf', 'B.PDF']);
    expect(result.skippedNonPdf).toEqual([]);
    expect(result.skippedOversize).toEqual([]);
  });

  it('rejects non-pdf and hidden files', () => {
    const result = filterPdfCandidates(
      [
        candidate({ fileName: 'index.csv' }),
        candidate({ fileName: '.DS_Store' }),
        // A hidden file that happens to end in .pdf is still junk, not a paper.
        candidate({ fileName: '.hidden.pdf' }),
        candidate({ fileName: 'ok.pdf' }),
      ],
      MAX
    );
    expect(result.accepted.map(f => f.fileName)).toEqual(['ok.pdf']);
    expect(result.skippedNonPdf.map(f => f.fileName)).toEqual(['index.csv', '.DS_Store', '.hidden.pdf']);
  });

  it('rejects files inside hidden directories anywhere in the relative path', () => {
    const result = filterPdfCandidates(
      [
        candidate({ fileName: 'x.pdf', relativePath: '.git/objects/x.pdf' }),
        candidate({ fileName: 'y.pdf', relativePath: 'archive/.cache/y.pdf' }),
        candidate({ fileName: 'ok.pdf', relativePath: 'archive/vendor-a/ok.pdf' }),
      ],
      MAX
    );
    expect(result.accepted.map(f => f.fileName)).toEqual(['ok.pdf']);
    expect(result.skippedNonPdf.map(f => f.fileName)).toEqual(['x.pdf', 'y.pdf']);
  });

  it('skips files at or over the max size, matching the createFabFile ">=" rejection', () => {
    const result = filterPdfCandidates(
      [
        candidate({ fileName: 'under.pdf', fileSize: MAX - 1 }),
        candidate({ fileName: 'exact.pdf', fileSize: MAX }),
        candidate({ fileName: 'over.pdf', fileSize: MAX + 1 }),
      ],
      MAX
    );
    expect(result.accepted.map(f => f.fileName)).toEqual(['under.pdf']);
    expect(result.skippedOversize.map(f => f.fileName)).toEqual(['exact.pdf', 'over.pdf']);
  });
});

describe('planUploads', () => {
  it('uploads everything when the lake has no existing files', () => {
    const plan = planUploads([hashed({ contentHash: 'h1' })], []);
    expect(plan.toUpload).toHaveLength(1);
    expect(plan.skippedExisting).toEqual([]);
    expect(plan.skippedDuplicateInBatch).toEqual([]);
  });

  it('skips candidates whose contentHash already exists in the lake', () => {
    const plan = planUploads(
      [hashed({ fileName: 'renamed.pdf', contentHash: 'h1' })],
      [{ fileName: 'original.pdf', fileSize: 42, contentHash: 'h1' }]
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.skippedExisting.map(f => f.fileName)).toEqual(['renamed.pdf']);
  });

  it('falls back to fileName+fileSize match when the existing file has no hash', () => {
    const plan = planUploads(
      [hashed({ fileName: 'paper.pdf', fileSize: 500, contentHash: 'h2' })],
      [{ fileName: 'paper.pdf', fileSize: 500, contentHash: null }]
    );
    expect(plan.toUpload).toEqual([]);
    expect(plan.skippedExisting.map(f => f.fileName)).toEqual(['paper.pdf']);
  });

  it('does not skip on fileName match alone when sizes differ', () => {
    const plan = planUploads(
      [hashed({ fileName: 'paper.pdf', fileSize: 501, contentHash: 'h2' })],
      [{ fileName: 'paper.pdf', fileSize: 500, contentHash: null }]
    );
    expect(plan.toUpload.map(f => f.fileName)).toEqual(['paper.pdf']);
  });

  it('dedupes identical hashes within the batch, keeping the first', () => {
    const plan = planUploads(
      [hashed({ fileName: 'first.pdf', contentHash: 'same' }), hashed({ fileName: 'copy.pdf', contentHash: 'same' })],
      []
    );
    expect(plan.toUpload.map(f => f.fileName)).toEqual(['first.pdf']);
    expect(plan.skippedDuplicateInBatch.map(f => f.fileName)).toEqual(['copy.pdf']);
  });
});

describe('splitStalePending', () => {
  const CUTOFF = new Date('2026-07-30T12:00:00Z');
  const doc = (overrides: Partial<ExistingLakeDoc> = {}): ExistingLakeDoc => ({
    id: 'id-1',
    fileName: 'paper.pdf',
    fileSize: 500,
    contentHash: 'h1',
    status: 'complete',
    createdAt: new Date('2026-07-30T11:00:00Z'),
    ...overrides,
  });

  it('flags old pending uploads as stale (their S3 event is lost)', () => {
    const result = splitStalePending([doc({ status: 'pending' })], CUTOFF);
    expect(result.stalePending).toHaveLength(1);
    expect(result.usable).toEqual([]);
  });

  it('keeps recent pending uploads usable to avoid racing an in-flight event', () => {
    const result = splitStalePending([doc({ status: 'pending', createdAt: new Date('2026-07-30T12:01:30Z') })], CUTOFF);
    expect(result.usable).toHaveLength(1);
    expect(result.stalePending).toEqual([]);
  });

  it('treats complete and unknown-status docs as usable', () => {
    const result = splitStalePending([doc(), doc({ status: undefined, id: 'id-2' })], CUTOFF);
    expect(result.usable).toHaveLength(2);
    expect(result.stalePending).toEqual([]);
  });
});

describe('resolveLakeTarget', () => {
  const staticConfigs = [
    {
      slug: 'opti-knowledge',
      name: 'Optimization KB',
      datalakeTag: 'datalake:opti-knowledge',
      fileTagPrefix: 'opti:',
    },
  ];

  it('carries the DB lake fields the membership scope is derived from', () => {
    const target = resolveLakeTarget(
      'my-lake',
      {
        id: 'db-1',
        slug: 'my-lake',
        name: 'My Lake',
        datalakeTag: 'datalake:my-lake',
        fileTagPrefix: 'mine:',
        createdByUserId: 'creator-1',
      },
      staticConfigs
    );
    expect(target).toEqual({
      source: 'db',
      id: 'db-1',
      slug: 'my-lake',
      name: 'My Lake',
      datalakeTag: 'datalake:my-lake',
      fileTagPrefix: 'mine:',
      createdByUserId: 'creator-1',
    });
  });

  it('falls back to the static registry with no creator, so the prefix arm cannot anchor', () => {
    const target = resolveLakeTarget('opti-knowledge', null, staticConfigs);
    expect(target).toEqual({
      source: 'static',
      slug: 'opti-knowledge',
      name: 'Optimization KB',
      datalakeTag: 'datalake:opti-knowledge',
      fileTagPrefix: 'opti:',
      createdByUserId: undefined,
    });
  });

  it('returns null when the slug matches neither', () => {
    expect(resolveLakeTarget('missing', null, staticConfigs)).toBeNull();
  });
});
