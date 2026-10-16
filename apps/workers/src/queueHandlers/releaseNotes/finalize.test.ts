import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scrubCustomerText, type ReleaseNotesJobPr } from '@bike4mind/common';
import { finalizeReleaseNote, findGenericCopy } from './finalize';
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
const run = (d: ReleaseNoteDraft, c = config, p = payload(), lastAttempt = false) =>
  finalizeReleaseNote(d, p, c, logger as never, { lastAttempt });

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
    ['Fixed in # 123 today', 'Fixed in today'],
    [`Fixed in #${String.fromCharCode(0x200b)}123 today`, 'Fixed in today'],
    [`Resolves ENG-${String.fromCharCode(0x2060)}1234, finally`, 'Resolves, finally'],
    ['Sign up at acme.io/signup today', 'Sign up at today'],
    ['Read [docs](https://evil.example/x) now', 'Read [docs] now'],
    ['Runs on Node.js/Deno now', 'Runs on Node.js/Deno now'],
  ])('scrubs %j', (input, expected) => {
    expect(scrubCustomerText(input)).toBe(expected);
  });

  it.each([
    'Now supports GPT-4 and GPT-4o.',
    'Use read/write access, 24/7.',
    'Pick your #1 model.',
    'Try gpt-4o-mini.',
    'Encrypted with AES-256 and sha-256.',
    'Shows the top-10 results.',
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

  it.each(['Built for A C M E', 'Built for A.C.M.E', 'Built for Ac-me', 'Built for ACME_Corp'])(
    'drops an item that spells a denylisted term with separators: %j',
    text => {
      const result = run(draft({ items: [item(text), item('Keep me.')] }), { embargoHours: 12, denylist: ['acme'] });

      expect(result.kind === 'ok' && result.note.items).toEqual([item('Keep me.')]);
    }
  );

  it.each([
    [`Built for ${String.fromCharCode(0x0430)}cme`, 'acme'],
    [`Built for ${String.fromCharCode(0x0410)}CME`, 'acme'],
    [`Built for Stra${String.fromCharCode(0xdf)}e`, 'strasse'],
    ['Built for Strasse', `stra${String.fromCharCode(0xdf)}e`],
  ])('drops an item that spells a denylisted term with lookalike letters: %j', (text, term) => {
    const result = run(draft({ items: [item(text), item('Keep me.')] }), { embargoHours: 12, denylist: [term] });

    expect(result.kind === 'ok' && result.note.items).toEqual([item('Keep me.')]);
  });

  it('matches a multi-word denylist term regardless of its own spacing', () => {
    const result = run(draft({ items: [item('Uses project-falcon now'), item('Keep me.')] }), {
      embargoHours: 12,
      denylist: ['Project Falcon'],
    });

    expect(result.kind === 'ok' && result.note.items).toEqual([item('Keep me.')]);
  });

  it('ignores denylist terms that hold no letters or digits', () => {
    expect(run(draft(), { embargoHours: 12, denylist: ['--', '...'] }).kind).toBe('ok');
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

describe('generic and hype copy', () => {
  beforeEach(() => vi.clearAllMocks());

  // Headlines the model actually published to production before this check existed.
  it.each([
    'Exciting New Features and Important Fixes in Your AI Workspace',
    'Exciting New Features and Important Fixes in Our Latest Update!',
    'Exciting Updates: New Features and Improvements in Your AI Workspace',
    'Exciting Updates and Fixes in Your AI Workspace',
    'Updates and improvements',
    'Powerful search for everyone',
  ])('rejects the headline %j', headline => {
    expect(findGenericCopy('headline', headline)).not.toEqual([]);
  });

  // Short filler with no "and" in it: only the whole-headline rule catches these.
  it.each(['Bug fixes', 'Minor updates', 'Various improvements', "What's new", 'bug fixes.'])(
    'rejects the bare filler headline %j',
    headline => {
      expect(findGenericCopy('headline', headline)).not.toEqual([]);
    }
  );

  // One word between the two nouns used to defeat the "X and Y" rule.
  it.each(['Bug fixes and performance improvements', 'Performance improvements and bug fixes'])(
    'rejects the headline %j',
    headline => {
      expect(findGenericCopy('headline', headline)).not.toEqual([]);
    }
  );

  it.each([
    'New Federated-Admin Endpoint Streamlines Admin Console Access',
    'Share skills with your team in the Skill Market',
    'Search improvements for scanned PDFs',
    'Desktop app updates itself in the background',
    'Fixes for stuck chat spinners',
    'Calendar sync fixes and Slack improvements',
    'Bug fixes for PDF export stalls',
    "See what's new in the Skill Market",
  ])('accepts the specific headline %j', headline => {
    expect(findGenericCopy('headline', headline)).toEqual([]);
  });

  it('flags hype and exclamation marks in the summary but not generic nouns', () => {
    expect(findGenericCopy('summary', 'This release adds new features and fixes.')).toEqual([]);
    expect(findGenericCopy('summary', 'An amazing release!')).toHaveLength(2);
  });

  it('asks for a rewrite with the reasons before the last attempt', () => {
    const result = run(draft({ headline: 'Exciting updates and fixes' }));

    expect(result).toEqual({ kind: 'repair', reasons: [expect.stringContaining('Exciting'), expect.anything()] });
  });

  it('builds the headline from the most important item on the last attempt', () => {
    const items = [
      { ...item('Exports are smaller.'), importance: 3 },
      { ...item('Share skills with your team in the Skill Market.'), importance: 1 },
    ];
    const result = run(draft({ headline: 'New features in your AI workspace', items }), config, payload(), true);

    expect(result.kind === 'ok' && result.note.headline).toBe('Share skills with your team in the Skill Market');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('still generic'), expect.anything());
  });

  it('drops a hype summary but keeps a specific headline on the last attempt', () => {
    const result = run(draft({ summary: 'An incredible release.' }), config, payload(), true);

    expect(result.kind === 'ok' && result.note).toMatchObject({ headline: 'Faster search', summary: '' });
  });

  it('caps a long fallback headline at 120 characters', () => {
    const result = run(draft({ headline: 'This release', items: [item('a'.repeat(200))] }), config, payload(), true);

    expect(result.kind === 'ok' && result.note.headline).toHaveLength(120);
  });

  it('does not split an astral character when it truncates the fallback headline', () => {
    const text = 'a'.repeat(116) + String.fromCodePoint(0x1f600) + 'z'.repeat(10);
    const result = run(draft({ headline: 'This release', items: [item(text)] }), config, payload(), true);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.note.headline.endsWith('...')).toBe(true);
    const before = result.note.headline.slice(0, -3);
    const last = before.charCodeAt(before.length - 1);
    expect(last < 0xd800 || last > 0xdbff).toBe(true);
  });

  it('skips an item whose text reads as hype when building the fallback headline', () => {
    const items = [
      { ...item('Voice mode works seamlessly across devices.'), importance: 1 },
      { ...item('Share skills with your team in the Skill Market.'), importance: 2 },
    ];
    const result = run(draft({ headline: 'New features', items }), config, payload(), true);

    expect(result.kind === 'ok' && result.note.headline).toBe('Share skills with your team in the Skill Market');
  });

  it('falls back to the most important item when no item reads as a specific headline', () => {
    const items = [{ ...item('Yahoo! Mail import is here.'), importance: 1 }];
    const result = run(draft({ headline: 'New features', items }), config, payload(), true);

    expect(result.kind === 'ok' && result.note.headline).toBe('Yahoo! Mail import is here');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('specific headline'), expect.anything());
  });

  it('checks the denylist before generic copy, so a denylist hit still asks for a rewrite', () => {
    const result = run(
      draft({ headline: 'Exciting Acme news' }),
      { embargoHours: 0, denylist: ['acme'] },
      payload(),
      true
    );

    expect(result).toEqual({ kind: 'repair', reasons: ['the headline must not mention "acme"'] });
  });
});
