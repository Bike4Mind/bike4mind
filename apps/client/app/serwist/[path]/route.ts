import { spawnSync } from 'node:child_process';
import { createSerwistRoute } from '@serwist/turbopack';
import { precacheGlobIgnores, precacheManifestTransforms } from '../../swPrecache';

// Get git revision for cache busting, fallback to random UUID
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout?.trim() || crypto.randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  additionalPrecacheEntries: [{ url: '/~offline', revision }],
  globIgnores: precacheGlobIgnores,
  manifestTransforms: precacheManifestTransforms,
  swSrc: 'app/sw.ts',
  // Copy relevant Next.js configuration (assetPrefix, basePath, distDir) if changed
  nextConfig: {},
});
