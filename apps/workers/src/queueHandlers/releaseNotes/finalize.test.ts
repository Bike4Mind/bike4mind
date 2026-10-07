import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReleaseNotesJobPr } from '@bike4mind/common';
import { finalizeReleaseNote, scrubCustomerText } from './finalize';
import type { ReleaseNoteDraft } from './generate';

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

const pr = (title: string): ReleaseNotesJobPr => ({ number: 1, title, labels: [], excerpt: '' });
const payload = (prs: ReleaseNotesJobPr[] = [pr('feat: thing')]) => ({
  releaseTag: 'v1.2.3.4',
  deployedSha: 'abc123',
  deployedAt: new Date('2026-01-01T00:00:00Z'),
  prs,
});
const item = (text: string) => ({ category: 'new' as const, text, importance: 2, sourcePrs: [1] });
const draft = (overrides: Partial<ReleaseNoteDraft> = {}): ReleaseNoteDraft => ({
  headline: 'Faster search',
  summary: 'Search got quicker.',
  items: [item('Search is quicker.')],
  ...overrides,
});
const config = { embargoHours: 12, denylist: [] as string[] };
const run = (d: ReleaseNoteDraft, c = config, p = payload()) => finalizeReleaseNote(d, p, c, logger as never);

describe('scrubCustomerText', () => {
  it.each([
    ['Search is quicker (#123).', 'Search is quicker.'],
    ['Fixed by #45 today', 'Fixed by today'],
    ['See https://github.com/acme/repo/pull/9 for more', 'See for more'],
    ['See github.com/acme/repo.', 'See.'],
    ['Resolves ENG-1234, finally', 'Resolves, finally'],
    ['Resolves eng-1234, finally', 'Resolves, finally'],
    ['Same as acme/repo#77 upstream', 'Same as upstream'],
    ['Details at https://linear.app/acme/issue/X-1.', 'Details at.'],
    ['Docs at www.example.com/internal now', 'Docs at now'],
    ['Changed apps/client/server/foo.ts behavior', 'Changed behavior'],
    ['Updated `src/utils/thing` code', 'Updated code'],
    ['Edited config.yaml/x.json now', 'Edited now'],
  ])('scrubs %j', (input, expected) => {
    expect(scrubCustomerText(input)).toBe(expected);
  });

  it.each([
    'Now supports GPT-4 and GPT-4o.',
    'Use read/write access, 24/7.',
    'Pick your #1 model.',
    'Try gpt-4o-mini.',
  ])('leaves ordinary copy alone: %j', input => {
    expect(scrubCustomerText(input)).toBe(input);
  });
});

describe('finalizeReleaseNote', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds a scheduled note with scrubbed text', () => {
    const result = run(draft({ items: [item('Search is quicker (#12).')] }));

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.note).toMatchObject({
      releaseTag: 'v1.2.3.4',
      status: 'scheduled',
      audience: 'public',
      editedAt: null,
      items: [item('Search is quicker.')],
    });
  });

  it('drops an item that hits the denylist, case-insensitively', () => {
    const result = run(draft({ items: [item('Uses Project Falcon now'), item('Keep me.')] }), {
      embargoHours: 12,
      denylist: ['  project falcon '],
    });

    expect(result.kind === 'ok' && result.note.items).toEqual([item('Keep me.')]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 item'), expect.anything());
  });

  it('requests a repair when the headline or summary hits the denylist', () => {
    const result = run(draft({ headline: 'Falcon lands', summary: 'All about FALCON.' }), {
      embargoHours: 12,
      denylist: ['falcon'],
    });

    expect(result).toEqual({
      kind: 'repair',
      reasons: ['the headline must not mention "falcon"', 'the summary must not mention "falcon"'],
    });
  });

  it('ignores blank denylist terms', () => {
    expect(run(draft(), { embargoHours: 12, denylist: ['', '   '] }).kind).toBe('ok');
  });

  it.each([
    [12, '2026-01-01T12:00:00.000Z'],
    [0, '2026-01-01T00:00:00.000Z'],
    [168, '2026-01-08T00:00:00.000Z'],
  ])('embargoes for %i hours', (embargoHours, expected) => {
    const result = run(draft(), { embargoHours, denylist: [] });

    expect(result.kind === 'ok' && result.note.publishAt.toISOString()).toBe(expected);
  });

  it('hides a zero-item note and warns when a feat/fix PR shipped', () => {
    const result = run(draft({ items: [] }), config, payload([pr('chore: deps'), pr('fix(chat)!: stuck spinner')]));

    expect(result.kind === 'ok' && result.note.status).toBe('hidden');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('feat/fix'), expect.anything());
  });

  it('hides a zero-item note quietly when only chores shipped', () => {
    const result = run(draft({ items: [item('(#55)')] }), config, payload([pr('chore: deps'), pr('ci: cache')]));

    expect(result.kind === 'ok' && result.note.status).toBe('hidden');
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('feat/fix'), expect.anything());
  });
});
