import { describe, expect, it } from 'vitest';
import { edgeToEdgePaths, isEdgeToEdgePath } from './premiumEdgeToEdge';

describe('edgeToEdgePaths', () => {
  it('keeps only the routes that set edgeToEdge', () => {
    expect(
      edgeToEdgePaths([{ path: '/alpha', edgeToEdge: true }, { path: '/beta' }, { path: '/gamma', edgeToEdge: false }])
    ).toEqual(['/alpha']);
  });

  it('is empty when no premium routes are registered', () => {
    expect(edgeToEdgePaths([])).toEqual([]);
  });
});

describe('isEdgeToEdgePath', () => {
  const paths = ['/alpha'];

  it('matches the route and its sub-paths', () => {
    expect(isEdgeToEdgePath('/alpha', paths)).toBe(true);
    expect(isEdgeToEdgePath('/alpha/report', paths)).toBe(true);
  });

  it('does not match a path that only shares the prefix', () => {
    expect(isEdgeToEdgePath('/alphabet', paths)).toBe(false);
  });

  it('does not match other routes', () => {
    expect(isEdgeToEdgePath('/', paths)).toBe(false);
    expect(isEdgeToEdgePath('/profile', paths)).toBe(false);
  });

  it('matches nothing when no route opted in', () => {
    expect(isEdgeToEdgePath('/alpha', [])).toBe(false);
  });
});
