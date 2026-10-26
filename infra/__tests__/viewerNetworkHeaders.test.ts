/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// infra/*.ts only loads inside `sst`, so these assertions read the sources as text.
const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const router = read('infra/router.ts');
const reader = read('packages/server-utils/src/utils/trustedClientIpHeaders.ts');

describe('viewer network header forwarding', () => {
  it('forwards every CloudFront viewer header that trustedClientIpHeaders.ts reads', () => {
    const forwarded = router.match(/headers: \{ items: \[([^\]]*)\] \}/)?.[1] ?? '';
    const readHeaders = [...reader.matchAll(/readHeader\('(cloudfront-viewer-[a-z-]+)'\)/g)].map(m => m[1]);
    expect(readHeaders.length).toBeGreaterThan(0);
    for (const header of readHeaders) {
      expect(forwarded.toLowerCase()).toContain(`'${header}'`);
    }
  });

  it('puts the custom origin request policy on the default cache behavior', () => {
    expect(router).toMatch(/headerBehavior: 'allViewerAndWhitelistCloudFront'/);
    expect(router).toMatch(/originRequestPolicyId: viewerNetworkOriginRequestPolicy\.id/);
  });
});
