import { describe, it, expect, vi } from 'vitest';
import type { ReleaseNotesJobPayload } from '@bike4mind/common';
import type { GitHubRelease } from '../utils/githubApi';
import {
  buildReleaseNotesPayload,
  capPayloadSize,
  enqueueReleaseNotes,
  excerptDescription,
  parseCustomerNote,
  selectBackfillPairs,
} from './buildPayload';

const sha40 = (tag: string) => Buffer.from(tag).toString('hex').padEnd(40, '0').slice(0, 40);

const release = (tag: string, createdAt: string): GitHubRelease => ({
  tag_name: tag,
  name: tag,
  body: '',
  created_at: createdAt,
  target_commitish: sha40(tag),
  html_url: `https://example.com/releases/${tag}`,
});

describe('parseCustomerNote', () => {
  it('returns the section text up to the next heading', () => {
    const body = '## Description\nx\n\n## Customer note\nSearch is faster.\n\n## Changes\n- a';
    expect(parseCustomerNote(body)).toBe('Search is faster.');
  });

  it('strips template comments and treats an untouched section as absent', () => {
    expect(parseCustomerNote('## Customer note\n<!-- fill me -->\n\n## Changes\n')).toBeUndefined();
    expect(parseCustomerNote('## Customer note\n<!-- c -->\nExport to CSV.')).toBe('Export to CSV.');
  });

  it('treats placeholders and a missing section as absent', () => {
    expect(parseCustomerNote('## Customer note\nN/A\n')).toBeUndefined();
    expect(parseCustomerNote('## customer NOTE\nnone')).toBeUndefined();
    expect(parseCustomerNote('## Description\nonly this')).toBeUndefined();
    expect(parseCustomerNote('')).toBeUndefined();
  });

  it('caps a long note', () => {
    expect(parseCustomerNote(`## Customer note\n${'x'.repeat(5000)}`)).toHaveLength(600);
  });

  it('keeps ### subheadings inside the note', () => {
    expect(parseCustomerNote('## Customer note\nLine one\n### Detail\nmore\n## Changes')).toBe(
      'Line one\n### Detail\nmore'
    );
  });
});

describe('excerptDescription', () => {
  it('drops comments, collapses whitespace and cuts to the limit', () => {
    expect(excerptDescription('<!-- t -->\nHello\n\n  world')).toBe('Hello world');
    expect(excerptDescription('a'.repeat(600))).toHaveLength(500);
  });
});

const payloadWith = (excerptChars: number, prCount: number, noteChars = 0): ReleaseNotesJobPayload => ({
  kind: 'release-notes',
  schemaVersion: 1,
  releaseTag: 'v1.0.0.1',
  releaseUrl: 'https://example.com',
  previousTag: 'v1.0.0.0',
  deployedSha: 'abc',
  deployedAt: new Date('2026-01-01T00:00:00Z'),
  prs: Array.from({ length: prCount }, (_, i) => ({
    number: i + 1,
    title: 't',
    labels: [],
    ...(noteChars ? { customerNote: 'n'.repeat(noteChars) } : {}),
    excerpt: 'e'.repeat(excerptChars),
  })),
});

describe('capPayloadSize', () => {
  it('leaves a small payload untouched', () => {
    const p = payloadWith(500, 3);
    expect(capPayloadSize(p)).toEqual(p);
  });

  it('cuts excerpts to 200 when 500 does not fit', () => {
    const capped = capPayloadSize(payloadWith(500, 10), 4_000);
    expect(capped.prs.every(pr => pr.excerpt.length === 200)).toBe(true);
  });

  it('drops excerpts entirely when 200 does not fit', () => {
    const capped = capPayloadSize(payloadWith(500, 10), 2_000);
    expect(capped.prs.every(pr => pr.excerpt === '')).toBe(true);
  });

  it('shortens customer notes only after excerpts are gone', () => {
    const capped = capPayloadSize(payloadWith(500, 10, 600), 4_000);
    expect(capped.prs.every(pr => pr.excerpt === '' && pr.customerNote?.length === 200)).toBe(true);
  });

  it('throws when the payload is too big even without excerpts', () => {
    expect(() => capPayloadSize(payloadWith(500, 10, 1_000), 2_000)).toThrow(/exceeds 2000 bytes/);
  });
});

describe('buildReleaseNotesPayload', () => {
  it('collects PRs from both merge and squash subjects, ignoring body references', async () => {
    const getCommitRange = vi.fn(async () => [
      {
        sha: '1',
        message: 'Merge pull request #12 from org/branch\n\nCloses #99',
        author: '',
        authorEmail: '',
        date: '',
      },
      { sha: '2', message: 'feat(x): thing (#7)', author: '', authorEmail: '', date: '' },
      { sha: '3', message: 'chore: direct push', author: '', authorEmail: '', date: '' },
      { sha: '4', message: 'fix: again (#7)', author: '', authorEmail: '', date: '' },
    ]);
    const getPRSummary = vi.fn(async (n: number) =>
      n === 12 ? null : { number: n, title: `PR ${n}`, labels: ['feature'], body: '## Customer note\nNew export.' }
    );

    const payload = await buildReleaseNotesPayload(release('v1.0.0.2', '2026-01-02T00:00:00Z'), 'v1.0.0.1', {
      getCommitRange,
      getPRSummary,
    });

    expect(getCommitRange).toHaveBeenCalledWith('v1.0.0.1', 'v1.0.0.2');
    expect(getPRSummary.mock.calls.map(([n]) => n)).toEqual([7, 12]);
    expect(payload.prs).toEqual([
      {
        number: 7,
        title: 'PR 7',
        labels: ['feature'],
        customerNote: 'New export.',
        excerpt: '## Customer note New export.',
      },
    ]);
    expect(payload).toMatchObject({ releaseTag: 'v1.0.0.2', deployedSha: sha40('v1.0.0.2'), previousTag: 'v1.0.0.1' });
  });

  it('anchors deployedAt to enqueue time, not the release creation date', async () => {
    const before = Date.now();
    const payload = await buildReleaseNotesPayload(release('v1.0.0.0', '2020-01-01T00:00:00Z'), null, {
      getCommitRange: vi.fn(),
      getPRSummary: vi.fn(),
    });
    expect(payload.deployedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('builds an empty PR list for the first release', async () => {
    const getCommitRange = vi.fn();
    const payload = await buildReleaseNotesPayload(release('v1.0.0.0', '2026-01-01T00:00:00Z'), null, {
      getCommitRange,
      getPRSummary: vi.fn(),
    });
    expect(getCommitRange).not.toHaveBeenCalled();
    expect(payload.prs).toEqual([]);
  });
});

describe('buildReleaseNotesPayload deployedSha', () => {
  const deps = (resolve: (ref: string) => Promise<string>) => ({
    getCommitRange: vi.fn(async () => []),
    getPRSummary: vi.fn(async () => null),
    resolveCommitSha: vi.fn(resolve),
  });

  it('resolves a branch-name target_commitish via the release tag', async () => {
    const d = deps(async () => 'a'.repeat(40));
    const payload = await buildReleaseNotesPayload(
      { ...release('v1.0.0.2', '2026-01-02T00:00:00Z'), target_commitish: 'main' },
      'v1.0.0.1',
      d
    );
    expect(d.resolveCommitSha).toHaveBeenCalledWith('v1.0.0.2');
    expect(payload.deployedSha).toBe('a'.repeat(40));
  });

  it('keeps a 40-hex target_commitish without calling GitHub', async () => {
    const d = deps(async () => 'b'.repeat(40));
    const payload = await buildReleaseNotesPayload(release('v1.0.0.2', '2026-01-02T00:00:00Z'), 'v1.0.0.1', d);
    expect(d.resolveCommitSha).not.toHaveBeenCalled();
    expect(payload.deployedSha).toBe(sha40('v1.0.0.2'));
  });
});

describe('selectBackfillPairs', () => {
  const releases = [
    release('v1.0.0.3', '2026-01-04T00:00:00Z'),
    release('v1.0.0.1', '2026-01-02T00:00:00Z'),
    release('v1.0.0.0', '2026-01-01T00:00:00Z'),
    release('preview-123', '2026-01-02T12:00:00Z'),
    release('v1.0.0.2', '2026-01-03T00:00:00Z'),
  ];

  it('pairs production releases oldest first with their predecessor', () => {
    expect(selectBackfillPairs(releases).map(p => [p.previousTag, p.release.tag_name])).toEqual([
      [null, 'v1.0.0.0'],
      ['v1.0.0.0', 'v1.0.0.1'],
      ['v1.0.0.1', 'v1.0.0.2'],
      ['v1.0.0.2', 'v1.0.0.3'],
    ]);
  });

  it('filters by date range but keeps the predecessor outside it', () => {
    const pairs = selectBackfillPairs(releases, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-03T00:00:00Z'));
    expect(pairs.map(p => [p.previousTag, p.release.tag_name])).toEqual([
      ['v1.0.0.0', 'v1.0.0.1'],
      ['v1.0.0.1', 'v1.0.0.2'],
    ]);
  });
});

describe('enqueueReleaseNotes', () => {
  it('sends the payload as the message body', async () => {
    const send = vi.fn(async (_command: unknown) => ({}));
    const payload = payloadWith(10, 1);
    await enqueueReleaseNotes({ send } as never, 'https://queue.example', payload);
    const command = send.mock.calls[0][0] as { input: { QueueUrl: string; MessageBody: string } };
    expect(command.input.QueueUrl).toBe('https://queue.example');
    expect(JSON.parse(command.input.MessageBody).releaseTag).toBe('v1.0.0.1');
  });
});
