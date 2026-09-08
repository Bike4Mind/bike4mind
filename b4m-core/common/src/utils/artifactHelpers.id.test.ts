import { describe, it, expect } from 'vitest';
import { createArtifactId, getArtifactIdentifier, remintArtifactId } from './artifactHelpers';

const segments = (id: string) => id.split('_');

/**
 * The shape the client parses is spread across `apps/client`, so these ids are a contract rather
 * than an implementation detail - see createArtifactId's JSDoc for which reader owns which
 * position. Source ids in these tests are written the way `generateCompleteArtifactId` writes them
 * (the identifier attribute verbatim, no slugifying), because that is the only shape the import
 * ever reads back.
 */
describe('createArtifactId', () => {
  it('satisfies both gates the client applies to an artifact id', () => {
    const id = createArtifactId('react', 'Sales Dashboard');

    expect(id.startsWith('artifact_')).toBe(true);
    expect(segments(id).length).toBeGreaterThanOrEqual(5);
    // Called with nothing, the defaults still fill both leading segments.
    expect(createArtifactId()).toMatch(/^artifact_generated_artifact_/);
  });

  it('slugs a title into the identifier segment', () => {
    // Only safe for a title: nothing compares this id against an `<artifact identifier=...>`
    // attribute. Carrying an existing identifier across goes through remintArtifactId instead.
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

describe('getArtifactIdentifier', () => {
  it('reads the identifier segment out of a parseable id', () => {
    expect(getArtifactIdentifier('artifact_react_todo-app_1700000000000_0')).toBe('todo-app');
  });

  it('returns undefined for a legacy id, whose segment 2 is a random discriminator', () => {
    // Legacy ids hold a random discriminator in this position, not an identifier - see the
    // function doc. Every row predating the shape fix carries one.
    expect(getArtifactIdentifier('artifact_1700000000000_k3f9dz1qp')).toBeUndefined();
  });

  it('returns undefined for an id that is not artifact-shaped at all', () => {
    expect(getArtifactIdentifier('6a9aacc0a73b5700defff05c')).toBeUndefined();
  });
});

describe('remintArtifactId', () => {
  it('carries the identifier segment across verbatim', () => {
    // The whole point of the function: `findExistingArtifactId` compares this segment for equality
    // against the raw attribute in the reply, and `generateCompleteArtifactId` wrote it raw into
    // the source id. Slugifying it - which is right for a title - is what breaks that match, so
    // the identifier here deliberately survives neither lowercasing nor a 40-char truncation.
    const identifier = 'Q3-Revenue-Breakdown-By-Region-And-Product-Line';
    const source = `artifact_recharts_${identifier}_1700000000000_0`;

    const reminted = remintArtifactId(source, 'recharts', 'Quarterly Revenue');

    expect(segments(reminted)[2]).toBe(identifier);
    expect(reminted).not.toBe(source);
    expect(segments(reminted).length).toBe(5);
    expect(segments(reminted)[3]).toMatch(/^\d+$/);
  });

  it('falls back to the title when the source id carries no identifier', () => {
    // A legacy `artifact_<ts>_<rand>` source has no attribute to preserve, so a slug of the title
    // is the best available guess - and strictly better than the random discriminator that sits in
    // segment 2 of that id.
    const reminted = remintArtifactId('artifact_1700000000000_k3f9dz1qp', 'svg', 'Red Circle');

    expect(segments(reminted)[2]).toBe('red-circle');
    expect(segments(reminted).length).toBe(5);
  });

  it('mints a distinct id every time so a copy never collides with its source', () => {
    const source = 'artifact_react_todo-app_1700000000000_0';
    const ids = new Set(Array.from({ length: 200 }, () => remintArtifactId(source, 'react', 'Todo App')));

    expect(ids.size).toBe(200);
    expect(ids.has(source)).toBe(false);
  });
});
