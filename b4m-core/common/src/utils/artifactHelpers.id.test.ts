import { describe, it, expect } from 'vitest';
import { createArtifactId } from './artifactHelpers';

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
    expect(createArtifactId()).toMatch(/^artifact_generated_artifact-/);
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
    // The timestamp alone does not separate them; the random suffix on the identifier segment does.
    const ids = new Set(Array.from({ length: 200 }, () => createArtifactId('code', 'Same Title')));

    expect(ids.size).toBe(200);
  });
});
