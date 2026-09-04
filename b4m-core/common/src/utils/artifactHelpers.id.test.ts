import { describe, it, expect } from 'vitest';
import { createArtifactId, getArtifactIdentifier } from './artifactHelpers';

/**
 * Guards the id shape createArtifactId promises to the client - see its JSDoc for why the five
 * segments and their positions are a contract, not an implementation detail.
 */
describe('createArtifactId', () => {
  const segments = (id: string) => id.split('_');

  it('satisfies both gates the client applies to an artifact id', () => {
    const id = createArtifactId('react', 'Sales Dashboard');

    expect(id.startsWith('artifact_')).toBe(true);
    expect(segments(id).length).toBeGreaterThanOrEqual(5);
    // Called with nothing, the defaults still fill both leading segments.
    expect(createArtifactId()).toMatch(/^artifact_generated_artifact_/);
  });

  it('leaves the identifier segment a clean slug so the rendered card can adopt the row', () => {
    // See createArtifactId's doc for why segment 2 has to stay comparable.
    expect(segments(createArtifactId('svg', 'Red Circle'))[2]).toBe('red-circle');
  });

  it('keeps the id five segments with both trailing ones numeric', () => {
    // The sibling minter (generateCompleteArtifactId) records a real integer index in the last
    // position, so this one keeps that position an integer too rather than reusing it for a base-36
    // tail: agreeing on where a segment sits is not enough if the two disagree on what it holds.
    // The by-id prefix fallback, `^<requested id>_\d+_\d+$`, assumes the same shape.
    const id = createArtifactId('svg', 'Red Circle');
    const identifierPrefix = segments(id).slice(0, 3).join('_');

    expect(segments(id)[3]).toMatch(/^\d+$/);
    expect(segments(id)[4]).toMatch(/^\d+$/);
    expect(new RegExp(`^${identifierPrefix}_\\d+_\\d+$`).test(id)).toBe(true);
  });

  it('round-trips its identifier segment through getArtifactIdentifier', () => {
    // This pair is the invariant the notebook import depends on: reminting an id for a copy has to
    // preserve the identifier the original carried, since the copy's reply still names it.
    const original = createArtifactId('react', 'Todo App');
    const reminted = createArtifactId('react', getArtifactIdentifier(original) ?? 'wrong');

    expect(getArtifactIdentifier(reminted)).toBe(getArtifactIdentifier(original));
    expect(reminted).not.toBe(original);
  });

  it('puts a parseable timestamp in the position the viewer reads', () => {
    const before = Date.now();
    const id = createArtifactId('svg', 'Red Circle');
    const stamped = Number(segments(id)[3]);

    expect(Number.isNaN(stamped)).toBe(false);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the segment positions honest when type or title contain separators', () => {
    // An underscore in either field would shift every later segment, putting something other than
    // the timestamp at index 3.
    const id = createArtifactId('my_type', 'A_title with spaces');

    expect(segments(id).length).toBe(5);
    expect(Number.isNaN(Number(segments(id)[3]))).toBe(false);
  });

  it('does not collide for two artifacts minted in the same millisecond', () => {
    // `id` is globally unique in the DB and the timestamp alone does not separate them, so a
    // same-title batch would throw on insert without the random suffix.
    const ids = new Set(Array.from({ length: 200 }, () => createArtifactId('code', 'Same Title')));

    expect(ids.size).toBe(200);
  });
});
