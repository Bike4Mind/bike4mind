/**
 * @vitest-environment node
 *
 * The source fetch Lambda reaches public hosts, so it must hold no VPC route and no secrets. Text-matched, like
 * remoteMcpIsolation: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { balanced, stripComments } from './helpers/infraSource';
import { FUNCTION_LIVE_SOURCE_KEY_PREFIX } from '../callableFunctionNetwork';
import {
  CALLABLE_FUNCTION_LIVE_SOURCE_KEY_PREFIX,
  callableFunctionLiveSourceKey,
} from '../../packages/server-utils/src/callableFunctions/dataKeys';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('callableFunctionSourceFetch', () => {
  const source = stripComments(read('infra/callableFunctionSourceFetch.ts'));
  const start = source.indexOf('new sst.aws.Function(');
  const declaration = balanced(source, start, '{', '}');

  it('is the worker entry, declared once', () => {
    expect(source.match(/new sst\.aws\.Function\(/g)).toHaveLength(1);
    expect(declaration).toContain("'apps/workers/src/callableFunctions/sourceFetch.handler'");
  });

  it('has no VPC, links nothing, and is granted nothing', () => {
    expect(declaration).not.toMatch(/\bvpc\b/i);
    expect(declaration).not.toMatch(/\blink\b/);
    expect(declaration).not.toMatch(/\bsecrets\b/);
    expect(declaration).not.toMatch(/\bpermissions\s*:/);
    expect(declaration).toMatch(/environment:\s*\{\s*\.\.\.DEFAULT_LAMBDA_ENVIRONMENT\s*\}/);
  });

  it('is invocable by the web API function only through its name and an invoke grant', () => {
    expect(source).toMatch(
      /actions:\s*\['lambda:InvokeFunction'\],\s*resources:\s*\[callableFunctionSourceFetch\.arn\]/
    );
    const web = stripComments(read('infra/web.ts'));
    expect(web).toContain('...callableFunctionSourceFetchForWeb.permissions');
    expect(web).toContain('...callableFunctionSourceFetchForWeb.environment');
  });

  it('keeps the handler free of the database and Config', () => {
    const handler = read('apps/workers/src/callableFunctions/sourceFetch.ts');
    const imports = [...handler.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    expect(imports).toEqual(['@bike4mind/server-utils/callableFunctions/fetchSource']);
    const fetcher = read('packages/server-utils/src/callableFunctions/fetchSource.ts');
    const fetcherImports = [...fetcher.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
    expect(fetcherImports).toEqual(['@aws-sdk/client-lambda', '@bike4mind/fab-pipeline/ssrf', 'node:crypto']);
  });
});

describe('live source fetches in the function-data bucket', () => {
  it('expire after one day, under the prefix the dispatcher writes them to', () => {
    expect(FUNCTION_LIVE_SOURCE_KEY_PREFIX).toBe(CALLABLE_FUNCTION_LIVE_SOURCE_KEY_PREFIX);
    expect(callableFunctionLiveSourceKey('fn1', 'a'.repeat(64)).startsWith(FUNCTION_LIVE_SOURCE_KEY_PREFIX)).toBe(true);
    const data = stripComments(read('infra/callableFunctionData.ts'));
    const secure = balanced(data, data.indexOf('function secureDataBucket('), '{', '}');
    const start = secure.indexOf("new aws.s3.BucketLifecycleConfigurationV2('CallableFunctionLiveSourceExpiry',");
    expect(start).toBeGreaterThan(-1);
    const rule = balanced(secure, start, '{', '}');
    expect(rule).toMatch(/bucket: bucket\.bucket,/);
    expect(rule).toMatch(
      /status: 'Enabled',\s*filter: \{ prefix: FUNCTION_LIVE_SOURCE_KEY_PREFIX \},\s*expiration: \{ days: 1 \},/
    );
  });
});
