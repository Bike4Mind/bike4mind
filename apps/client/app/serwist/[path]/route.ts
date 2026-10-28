import { spawnSync } from 'node:child_process';
import { createSerwistRoute } from '@serwist/turbopack';

// Get git revision for cache busting, fallback to random UUID. It also changes the worker bytes on
// every deploy, which is what lets an installed worker pick up a new CSP (see proxy.ts).
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout?.trim() || crypto.randomUUID();

export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } = createSerwistRoute({
  additionalPrecacheEntries: [{ url: '/~offline', revision }],
  swSrc: 'app/sw.ts',
  // Copy relevant Next.js configuration (assetPrefix, basePath, distDir) if changed
  nextConfig: {},
});
