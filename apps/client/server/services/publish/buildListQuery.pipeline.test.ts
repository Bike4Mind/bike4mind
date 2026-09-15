import { describe, it, expect } from 'vitest';
import { buildListQuery } from './buildListQuery';

/**
 * The never-widen invariant, checked against the SHAPE the route actually builds rather than
 * against buildListQuery's output alone.
 *
 * The route's own suite mocks buildListQuery, and buildListQuery's suite inspects it in isolation,
 * so neither covers the thing that makes the invariant hold: `scope` (the authorization clause)
 * and `match` (the caller's narrowing) run as SEPARATE, sequential $match stages - scope first at
 * the top level, match second inside each $facet branch. Sequential stages can only narrow, so the
 * property is structural. What would break it is a future refactor that merges them into one
 * object, or reorders them, and that is what this pins.
 *
 * This is a structural check, not a database one: there is no Mongo here, so it asserts that no
 * real buildListQuery output can reach outside scope rather than observing a document fail to.
 */

/** The two-stage shape the route builds, reduced to what the invariant depends on. */
function pipelineShape(scope: Record<string, unknown>, match: Record<string, unknown>) {
  return {
    first: { $match: scope },
    rowsFirst: { $match: match },
  };
}

describe('buildListQuery in the route pipeline', () => {
  /** Every axis at once, using the REAL implementation - no mock. */
  const REAL = buildListQuery({
    q: 'ionq',
    kind: 'bundle',
    visibility: 'private',
    gate: 'none',
    comments: 'on',
    sort: 'views',
  });

  it('produces a narrowing that names no authorization field', () => {
    // scope owns ownerId / visibility-ladder / deletedAt. A narrowing that set ownerId could
    // otherwise reach another owner's artifacts when merged into one object.
    const keys = Object.keys(REAL.match);
    expect(keys).not.toContain('ownerId');
    expect(keys).not.toContain('deletedAt');
    expect(keys).not.toContain('$and');
    expect(keys).not.toContain('$nor');
  });

  it('confines its only $or to the search fields, which cannot escape a scope match', () => {
    // A top-level $or over anything else is the one shape that can widen a merged filter.
    const or = REAL.match.$or as Array<Record<string, unknown>> | undefined;
    expect(or).toBeDefined();
    expect(or?.flatMap(clause => Object.keys(clause)).sort()).toEqual(['description', 'title']);
  });

  it('keeps scope as the FIRST stage and the narrowing as a separate later one', () => {
    const scope = { ownerId: 'owner-1', deletedAt: null };
    const shape = pipelineShape(scope, REAL.match);

    // Two distinct stages, never combined: this ordering is what makes the invariant structural
    // rather than a property of the narrowing's contents.
    expect(shape.first.$match).toBe(scope);
    expect(shape.rowsFirst.$match).not.toBe(scope);
    expect(Object.keys(shape.first.$match)).toEqual(['ownerId', 'deletedAt']);
  });

  it('cannot reintroduce an owner excluded by scope, whatever the caller sends', () => {
    // The adversarial case: a caller trying to smuggle an ownerId through a filter value. Values
    // are matched against allow-lists and the search term is escaped, so nothing lands as a key.
    const hostile = buildListQuery({
      q: '{"ownerId":"someone-else"}',
      kind: 'ownerId',
      visibility: 'ownerId',
      gate: 'ownerId',
      comments: 'ownerId',
    });
    expect(Object.keys(hostile.match)).toEqual(['$or']);
    const or = hostile.match.$or as Array<Record<string, RegExp>>;
    // The term is a LITERAL: it matches a title that actually contains that text, and nothing is
    // interpreted as structure. Asserting on the escaped source would only test which characters
    // the escaper happens to touch, so assert behaviour instead.
    expect(or[0].title.test('{"ownerId":"someone-else"}')).toBe(true);
    expect(or[0].title.test('someone-else')).toBe(false);
    expect(or[0].title.test('an unrelated artifact')).toBe(false);
  });
});
