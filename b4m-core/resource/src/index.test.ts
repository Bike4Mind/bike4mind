import { describe, expect, test } from 'vitest';
import { createResource, type Manifest } from './index';

describe('createResource — self-host Resource shim', () => {
  test('App.stage reflects APP_STAGE env', () => {
    const Resource = createResource({ APP_STAGE: 'selfhost' });
    expect(Resource.App.stage).toBe('selfhost');
  });

  test('App.stage and App.name fall back to defaults when unset', () => {
    const Resource = createResource({});
    expect(Resource.App.stage).toBe('selfhost');
    expect(Resource.App.name).toBe('bike4mind');
  });

  test('secret resolves to { value } from an env var of the same name', () => {
    const manifest: Manifest = { MONGODB_URI: { kind: 'secret' } };
    const Resource = createResource({ MONGODB_URI: 'mongodb://x' }, manifest);
    expect(Resource.MONGODB_URI.value).toBe('mongodb://x');
  });

  test('bucket resolves to { name } from a SCREAMING_SNAKE env var', () => {
    const manifest: Manifest = { appFilesBucket: { kind: 'bucket' } };
    const Resource = createResource({ APP_FILES_BUCKET: 'app-files' }, manifest);
    expect(Resource.appFilesBucket.name).toBe('app-files');
  });

  test('queue resolves to { url } from a SCREAMING_SNAKE env var', () => {
    const manifest: Manifest = { agentContinuationQueue: { kind: 'queue' } };
    const Resource = createResource({ AGENT_CONTINUATION_QUEUE: 'http://mq:9324/q/agent' }, manifest);
    expect(Resource.agentContinuationQueue.url).toBe('http://mq:9324/q/agent');
  });

  test('function resolves to { name } from a SCREAMING_SNAKE env var', () => {
    const manifest: Manifest = { ImageProcessor: { kind: 'function' } };
    const Resource = createResource({ IMAGE_PROCESSOR: 'image-processor' }, manifest);
    expect(Resource.ImageProcessor.name).toBe('image-processor');
  });

  test('websocket resolves managementEndpoint and url', () => {
    const manifest: Manifest = { websocket: { kind: 'websocket' } };
    const Resource = createResource(
      { WEBSOCKET_MANAGEMENT_ENDPOINT: 'http://ws:3001', WEBSOCKET_URL: 'ws://ws:3001' },
      manifest
    );
    expect(Resource.websocket.managementEndpoint).toBe('http://ws:3001');
    expect(Resource.websocket.url).toBe('ws://ws:3001');
  });

  test('reading a required secret that is unset throws a clear, actionable error', () => {
    const manifest: Manifest = { MONGODB_URI: { kind: 'secret' } };
    const Resource = createResource({}, manifest);
    expect(() => Resource.MONGODB_URI.value).toThrow(/MONGODB_URI/);
  });

  test('optional secret returns undefined when unset (does not throw)', () => {
    const manifest: Manifest = { SLACK_WEBHOOK_URL: { kind: 'secret', optional: true } };
    const Resource = createResource({}, manifest);
    expect(Resource.SLACK_WEBHOOK_URL.value).toBeUndefined();
  });

  test('SCREAMING_SNAKE secret names with digits map to the identical env var', () => {
    // Regression: `B4M_PROD_API_KEY` / `E2E_CLEANUP_SECRET` must NOT become
    // `B4_M_PROD_API_KEY` / `E2_E_CLEANUP_SECRET` - the real secret keeps its name.
    const manifest: Manifest = {
      B4M_PROD_API_KEY: { kind: 'secret' },
      E2E_CLEANUP_SECRET: { kind: 'secret' },
    };
    const Resource = createResource({ B4M_PROD_API_KEY: 'prod-key', E2E_CLEANUP_SECRET: 'e2e-key' }, manifest);
    expect(Resource.B4M_PROD_API_KEY.value).toBe('prod-key');
    expect(Resource.E2E_CLEANUP_SECRET.value).toBe('e2e-key');
  });

  test('record kind parses JSON from env, is undefined when unset', () => {
    const manifest: Manifest = { lambdaFunctionNames: { kind: 'record', optional: true } };
    const set = createResource({ LAMBDA_FUNCTION_NAMES: '{"attackSimulation":"fn-1"}' }, manifest);
    expect(set.lambdaFunctionNames?.attackSimulation).toBe('fn-1');
    const unset = createResource({}, manifest);
    expect(unset.lambdaFunctionNames).toBeUndefined();
  });
});

describe('DEFAULT_MANIFEST — the self-host manifest contract', () => {
  test('createResource() with no manifest knows the real resources', () => {
    const Resource = createResource({ MONGODB_URI: 'mongodb://x', APP_FILES_BUCKET: 'app-files' });
    expect(Resource.MONGODB_URI.value).toBe('mongodb://x');
    expect(Resource.appFilesBucket.name).toBe('app-files');
  });

  test('reading a resource not in the manifest throws (misconfiguration caught early)', () => {
    const Resource = createResource({});
    // @ts-expect-error - not a real resource, must not typecheck nor resolve
    expect(() => Resource.totallyMadeUpResource.value).toThrow(/not registered/);
  });
});
