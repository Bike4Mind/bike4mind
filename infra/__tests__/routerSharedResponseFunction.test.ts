/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  NOINDEX_HEADER_VALUE,
  USER_FILE_CSP,
  USER_FILE_MARKER_HEADER,
  noindexResponseInjection,
  responseFunctionCode,
  sharedPreviewResponseFunctionCode,
  userFileCdnPrefixes,
  userFileCspInjection,
} from '../routerFunctionCode';

// infra/router.ts only loads inside `sst`, so wiring is asserted against its source text.
const router = readFileSync(new URL('../router.ts', import.meta.url), 'utf8');
const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8'));

const run = async (request: { uri: string; headers?: Record<string, { value: string }> }) => {
  // The vm has no module loader; the `cloudfront` import is unused by this code.
  const code = sharedPreviewResponseFunctionCode().replace(/^\s*import cf from "cloudfront";\n/, '');
  const event = {
    request: { headers: {}, ...request },
    response: { headers: { 'cache-control': { value: 'no-store' } } },
  };
  const response = await runInNewContext(`${code}\nhandler(event)`, { event });
  return response.headers as Record<string, { value: string }>;
};

describe('shared preview viewer-response function', () => {
  it('holds exactly what a preview stage of its own would hold', () => {
    const ownCode = responseFunctionCode(
      userFileCspInjection(userFileCdnPrefixes) + noindexResponseInjection('pr1234')
    );
    expect(sharedPreviewResponseFunctionCode()).toBe(ownCode);
  });

  it('uses the cloudfront-js-2.0 handler shape SST generates', () => {
    expect(sharedPreviewResponseFunctionCode()).toMatch(
      /^\s*import cf from "cloudfront";\nasync function handler\(event\) \{[\s\S]*return event\.response;\n\}$/
    );
  });

  it('marks every response noindex', async () => {
    expect((await run({ uri: '/' }))['x-robots-tag']).toEqual({ value: NOINDEX_HEADER_VALUE });
  });

  it('applies the CSP backstop to marked user-file responses', async () => {
    const headers = await run({ uri: '/x', headers: { [USER_FILE_MARKER_HEADER]: { value: '1' } } });
    expect(headers['content-security-policy']).toEqual({ value: USER_FILE_CSP });
    expect(headers['x-content-type-options']).toEqual({ value: 'nosniff' });
  });

  it('applies the CSP backstop to bare user-file prefixes', async () => {
    const headers = await run({ uri: '/profile-photos/a.svg' });
    expect(headers['content-security-policy']).toEqual({ value: USER_FILE_CSP });
  });

  it('leaves the SPA and API responses alone', async () => {
    const headers = await run({ uri: '/api/ai/v1/completions' });
    expect(headers['content-security-policy']).toBeUndefined();
    expect(headers['cache-control']).toEqual({ value: 'no-store' });
  });
});

describe('router wiring for the shared response function', () => {
  it('reads the ARN only on preview stages', () => {
    expect(router).toMatch(
      /const sharedResponseFunctionArn =\s*isPreviewStage && !\$dev \? process\.env\.PREVIEW_SHARED_RESPONSE_FUNCTION_ARN \|\| undefined : undefined/
    );
  });

  it('omits edge.viewerResponse when the shared ARN is set', () => {
    expect(router).toMatch(/\.\.\.\(sharedResponseFunctionArn\s*\? \{\}\s*: \{\s*viewerResponse: \{/);
  });

  it('appends a viewer-response association to the default behavior', () => {
    expect(router).toMatch(
      /functionAssociations: \$output\(behavior\.functionAssociations \?\? \[\]\)\.apply\(associations => \[\s*\.\.\.associations,\s*\{ eventType: 'viewer-response', functionArn: sharedResponseFunctionArn \}/
    );
  });

  it('declares the deploy-time variable in the contract', () => {
    expect(contract.deployEnv).toContain('PREVIEW_SHARED_RESPONSE_FUNCTION_ARN');
  });
});
