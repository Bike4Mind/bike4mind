// @vitest-environment node
// Lives outside pages/: Next compiles every .ts file there as a route, and next.config.mjs cannot be
// bundled into one.
import { describe, expect, it } from 'vitest';

import nextConfig from './next.config.mjs';

describe('next.config rewrites', () => {
  it.each([
    ['/.well-known/assetlinks.json', '/api/well-known/assetlinks'],
    ['/.well-known/apple-app-site-association', '/api/well-known/apple-app-site-association'],
  ])('maps %s to %s without a redirect', async (source, destination) => {
    const rewrites = await nextConfig.rewrites();
    const list = Array.isArray(rewrites) ? rewrites : rewrites.beforeFiles;
    expect(list).toContainEqual({ source, destination });
  });
});
