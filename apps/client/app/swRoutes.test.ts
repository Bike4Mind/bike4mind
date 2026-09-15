import { describe, it, expect } from 'vitest';
import { isApiPath } from './swRoutes';

describe('isApiPath', () => {
  it('matches Next.js API routes that must never be SW-cached', () => {
    expect(isApiPath('/api/react-artifact-sandbox')).toBe(true);
    expect(isApiPath('/api/artifact-sandbox')).toBe(true);
    expect(isApiPath('/api/publish/serve')).toBe(true);
    expect(isApiPath('/api/overwatch/v1/events')).toBe(true);
    // bare /api with no trailing segment
    expect(isApiPath('/api')).toBe(true);
  });

  it('does not over-match non-API paths', () => {
    // SPA routes and static assets must keep their normal caching behavior
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/s/abc123')).toBe(false);
    expect(isApiPath('/_next/static/chunk.js')).toBe(false);
    // prefix collisions that are NOT under /api/
    expect(isApiPath('/apiary')).toBe(false);
    expect(isApiPath('/api-docs')).toBe(false);
    expect(isApiPath('/foo/api/bar')).toBe(false);
  });
});
