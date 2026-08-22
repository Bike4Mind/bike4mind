import { describe, it, expect } from 'vitest';
import { buildListQuery } from './buildListQuery';

describe('buildListQuery - search', () => {
  it('matches the term against title AND description, case-insensitively', () => {
    const { match } = buildListQuery({ q: 'IonQ' });
    const or = match.$or as Array<Record<string, RegExp>>;

    expect(or).toHaveLength(2);
    expect(or[0].title.test('ionq weekly')).toBe(true);
    expect(or[1].description.test('About IONQ')).toBe(true);
  });

  it('treats the term as a literal, so regex metacharacters cannot widen the match', () => {
    // `.*` unescaped would match every artifact - a search box that returns everything for a
    // plausible typo. `(` unescaped throws at query time and 500s the list.
    const { match } = buildListQuery({ q: '.*' });
    const or = match.$or as Array<Record<string, RegExp>>;

    expect(or[0].title.test('anything at all')).toBe(false);
    expect(or[0].title.test('a .* literal')).toBe(true);
    expect(() => buildListQuery({ q: '(unclosed' })).not.toThrow();
  });

  it('ignores a blank or whitespace-only term rather than matching everything', () => {
    expect(buildListQuery({ q: '' }).match.$or).toBeUndefined();
    expect(buildListQuery({ q: '   ' }).match.$or).toBeUndefined();
  });
});

describe('buildListQuery - facet filters', () => {
  it('filters by kind, visibility and comments', () => {
    expect(buildListQuery({ kind: 'bundle' }).match['source.kind']).toBe('bundle');
    expect(buildListQuery({ visibility: 'public' }).match.visibility).toBe('public');
    expect(buildListQuery({ comments: 'on' }).match.commentPolicy).toEqual({ $in: ['open', 'restricted'] });
    expect(buildListQuery({ comments: 'off' }).match.commentPolicy).toEqual({ $nin: ['open', 'restricted'] });
  });

  it('expresses gate: none as the ABSENCE of a gate, not a literal', () => {
    // 'none' is synthetic - an ungated artifact has no accessGate subdocument at all, so
    // matching the string would return zero rows for the most common case.
    expect(buildListQuery({ gate: 'none' }).match['accessGate.kind']).toEqual({ $exists: false });
    expect(buildListQuery({ gate: 'passphrase' }).match['accessGate.kind']).toBe('passphrase');
  });

  it('IGNORES an unknown filter value instead of passing it through', () => {
    // A value Mongo cannot satisfy returns nothing, which reads to the owner as "you have no
    // artifacts" rather than "that is not a real filter" - so a stale bookmark or a typo in a
    // hand-edited URL should degrade to showing results, not to an empty page.
    expect(buildListQuery({ kind: 'wat' }).match['source.kind']).toBeUndefined();
    expect(buildListQuery({ visibility: 'everyone' }).match.visibility).toBeUndefined();
    expect(buildListQuery({ gate: 'fingerprint' }).match['accessGate.kind']).toBeUndefined();
    expect(buildListQuery({ comments: 'maybe' }).match.commentPolicy).toBeUndefined();
  });

  it('never emits a clause that could WIDEN the authorized set', () => {
    // The route $and-merges this onto buildListVisibilityFilter's authorization clause. Every
    // key here must be a narrowing constraint; an $or at the top level (other than the
    // search's own title/description pair) would be able to reach outside that set.
    const { match } = buildListQuery({
      q: 'x',
      kind: 'bundle',
      visibility: 'private',
      gate: 'none',
      comments: 'on',
    });
    const or = match.$or as Array<Record<string, unknown>>;
    expect(Object.keys(or[0])).toEqual(['title']);
    expect(Object.keys(or[1])).toEqual(['description']);
    expect(Object.keys(match).sort()).toEqual(
      ['$or', 'accessGate.kind', 'commentPolicy', 'source.kind', 'visibility'].sort()
    );
  });
});

describe('buildListQuery - sort', () => {
  it('defaults to newest-first', () => {
    expect(buildListQuery({}).sort).toEqual({ publishedAt: -1, publicId: 1 });
    expect(buildListQuery({ sort: 'nonsense' }).sort).toEqual({ publishedAt: -1, publicId: 1 });
  });

  it('breaks ties on publicId for every sort, so paging cannot drop or repeat a row', () => {
    // Two artifacts published in the same second are otherwise free to swap places between
    // page 1 and page 2, which shows one twice and hides another entirely.
    for (const sort of ['newest', 'oldest', 'views', 'versions', 'updated', 'title']) {
      expect(buildListQuery({ sort }).sort.publicId).toBe(1);
    }
  });

  it('sorts titles on the lowercased field, not raw byte order', () => {
    // A raw { title: 1 } puts every capitalised title ahead of every lowercase one.
    expect(buildListQuery({ sort: 'title' }).sort).toEqual({ titleSort: 1, publicId: 1 });
  });

  it('sorts by version count on the derived field the route adds before $sort', () => {
    expect(buildListQuery({ sort: 'versions' }).sort.versionsCount).toBe(-1);
  });
});
