// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { locateCitedPassage, blockIntersectsPassage, citedPassageOf, citedPassageForFile } from './citedPassage';

const DOC = [
  '# Leave policy',
  '',
  'Holidays accrue monthly.',
  'Unused days roll over once.',
  '',
  '> See appendix.',
].join('\n');

describe('locateCitedPassage', () => {
  it('finds a passage that is a byte-for-byte slice', () => {
    const range = locateCitedPassage(DOC, 'Holidays accrue monthly.');
    expect(DOC.slice(range!.start, range!.end)).toBe('Holidays accrue monthly.');
  });

  it('spans the whole passage when it crosses a line break', () => {
    // The serve path joins nothing - the passage keeps the document's own newline, and the range
    // has to cover both lines or the highlight stops halfway through the cited text.
    const range = locateCitedPassage(DOC, 'Holidays accrue monthly.\nUnused days roll over once.');
    expect(DOC.slice(range!.start, range!.end)).toBe('Holidays accrue monthly.\nUnused days roll over once.');
  });

  it('matches through the defang space the serve path inserts', () => {
    // defangRetrievedContent prepends a space to a line opening with a marker, so the served text
    // differs from the document by exactly that space. An exact indexOf would miss here.
    const range = locateCitedPassage(DOC, ' > See appendix.');
    expect(DOC.slice(range!.start, range!.end)).toBe('> See appendix.');
  });

  it('matches a clipped passage, ignoring the trailing clip marker', () => {
    const range = locateCitedPassage(DOC, 'Holidays accrue\u2026');
    expect(DOC.slice(range!.start, range!.end)).toBe('Holidays accrue');
  });

  it('returns null when the passage is not in this document', () => {
    // Null, never a nearest guess: a wrong range would scroll the reader to an uncited paragraph
    // and mark it as the evidence, which is worse than leaving the document unmarked.
    expect(locateCitedPassage(DOC, 'Sabbaticals are granted yearly.')).toBeNull();
  });

  it('returns null for a whitespace-only passage rather than matching at offset 0', () => {
    expect(locateCitedPassage(DOC, '   \n  ')).toBeNull();
  });
});

describe('blockIntersectsPassage', () => {
  const passage = { start: 10, end: 20 };

  it('marks a block that overlaps the passage', () => {
    expect(blockIntersectsPassage({ start: 15, end: 25 }, passage)).toBe(true);
  });

  it('marks a block the passage sits entirely inside', () => {
    expect(blockIntersectsPassage({ start: 0, end: 30 }, passage)).toBe(true);
  });

  it('does not mark a block that merely abuts the passage end', () => {
    // Half-open on both sides. Marking the next paragraph would widen what the highlight claims
    // was cited, which is the failure mode a reader checking a claim would notice first.
    expect(blockIntersectsPassage({ start: 20, end: 30 }, passage)).toBe(false);
  });

  it('does not mark a block that merely abuts the passage start', () => {
    expect(blockIntersectsPassage({ start: 0, end: 10 }, passage)).toBe(false);
  });

  it('does not mark a block with no source position', () => {
    // react-markdown omits `position` on nodes it synthesizes, and `undefined < n` is false in a
    // naive comparison - guarding here keeps a synthesized block from being silently marked.
    expect(blockIntersectsPassage(undefined, passage)).toBe(false);
    expect(blockIntersectsPassage({ start: 15 }, passage)).toBe(false);
  });
});

describe('citedPassageOf', () => {
  const chip = (metadata?: Record<string, unknown>) =>
    ({ id: 'f1', type: 'document', title: 'Doc', metadata }) as unknown as Parameters<typeof citedPassageOf>[0];

  it('reads the anchor off a chunk-bearing chip', () => {
    expect(citedPassageOf(chip({ chunkId: 'c1', fullContext: 'Holidays accrue monthly.' }))).toEqual({
      fileId: 'f1',
      chunkId: 'c1',
      passage: 'Holidays accrue monthly.',
    });
  });

  it('returns null for a file-level chip, so the reader gets the whole document', () => {
    expect(citedPassageOf(chip({ sourceSystem: 'knowledge_base', relevanceScore: 0.9 }))).toBeNull();
    expect(citedPassageOf(chip(undefined))).toBeNull();
  });

  it('returns null when only half the anchor is present', () => {
    // Either half alone is useless: an id nothing can resolve to text, or text nothing can key on.
    expect(citedPassageOf(chip({ chunkId: 'c1' }))).toBeNull();
    expect(citedPassageOf(chip({ fullContext: 'Holidays accrue monthly.' }))).toBeNull();
  });

  it('returns null for a blank passage rather than anchoring on nothing', () => {
    expect(citedPassageOf(chip({ chunkId: 'c1', fullContext: '   ' }))).toBeNull();
  });
});

/**
 * The id guard is the ONLY thing standing between a single shared anchor slot and a citation into
 * one document marking colliding text in another, and it is invisible in both viewers it runs in -
 * so it is asserted here rather than only through a render.
 */
describe('citedPassageForFile', () => {
  const anchor = { fileId: 'file-a', chunkId: 'chunk-1', passage: 'Holidays accrue monthly.' };

  it('returns the passage when the anchor is for this file', () => {
    expect(citedPassageForFile(anchor, 'file-a')).toBe('Holidays accrue monthly.');
  });

  it('returns undefined when the anchor points at a DIFFERENT file', () => {
    // The failure this prevents: opening file B while an anchor for A is live would mark whatever
    // text in B happens to match A's passage, with no signal to the reader that it is wrong.
    expect(citedPassageForFile(anchor, 'file-b')).toBeUndefined();
  });

  it('returns undefined when there is no anchor', () => {
    expect(citedPassageForFile(null, 'file-a')).toBeUndefined();
    expect(citedPassageForFile(undefined, 'file-a')).toBeUndefined();
  });

  it('returns undefined when there is no file to render', () => {
    // Both absent must not compare equal as undefined === undefined and leak the anchor through.
    expect(citedPassageForFile(anchor, undefined)).toBeUndefined();
    expect(citedPassageForFile(anchor, null)).toBeUndefined();
    expect(citedPassageForFile(null, undefined)).toBeUndefined();
  });
});
