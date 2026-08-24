import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createResource, type Manifest } from './index';
import { DEFAULT_MANIFEST } from './manifest';

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

  test('service resolves to { url } from a SCREAMING_SNAKE env var', () => {
    const manifest: Manifest = { ChatCompletion: { kind: 'service' } };
    const Resource = createResource({ CHAT_COMPLETION: 'http://chatcompletion:8080' }, manifest);
    expect(Resource.ChatCompletion.url).toBe('http://chatcompletion:8080');
  });

  test('service (required) throws when its env var is unset', () => {
    const manifest: Manifest = { ChatCompletion: { kind: 'service' } };
    const Resource = createResource({}, manifest);
    expect(() => Resource.ChatCompletion.url).toThrow(/CHAT_COMPLETION/);
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

  test('sourceQueueUrls maps queue names to env URLs so getSourceQueueUrl resolves in self-host', () => {
    // getSourceQueueUrl (dlqRegistry) reads Resource.sourceQueueUrls[name]. Hosted links a
    // Linkable for it to the frontend; the shim computes the same map from the per-queue env
    // vars, so research + RAG enqueue sites resolve identically under B4M_SELF_HOST.
    const Resource = createResource({
      RESEARCH_ENGINE_QUEUE: 'http://mq:9324/q/research',
      FAB_FILE_CHUNK_QUEUE: 'http://mq:9324/q/chunk',
      FAB_FILE_VECTORIZE_QUEUE: 'http://mq:9324/q/vectorize',
    });
    const map = Resource.sourceQueueUrls as Record<string, string | undefined>;
    expect(map.researchEngineQueue).toBe('http://mq:9324/q/research');
    expect(map.fabFileChunkQueue).toBe('http://mq:9324/q/chunk');
    expect(map.fabFileVectorizeQueue).toBe('http://mq:9324/q/vectorize');
    // A queue with no env var resolves to undefined (getSourceQueueUrl then reports missing).
    expect(map.imageGenerationQueue).toBeUndefined();
  });
});

/**
 * The self-host queue wiring lives in three hand-maintained files that must agree, and nothing
 * compared them until a queue went missing from two of them at once. A queue the code reads via
 * `Resource.<name>.url` needs an entry in all three: the manifest (or the read throws), the
 * ElasticMQ config (or the broker has nowhere to put the message) and the env template (or no
 * operator ever sets the URL).
 *
 * These run in one direction only - manifest and broker config outward to the env template. The
 * reverse is legitimately allowed: `selfHostEventQueue` is read straight from its env var rather
 * than through `Resource`, and `tavernHeartbeatQueue` is served by a premium overlay, so neither
 * belongs in the manifest. Directional checks keep this honest without an exemption list to rot.
 */
const REPO_ROOT = join(__dirname, '../../..');

const manifestQueues = (): string[] =>
  Object.entries(DEFAULT_MANIFEST)
    .filter(([, entry]) => entry.kind === 'queue')
    .map(([name]) => name);

const brokerQueues = (): string[] => {
  const conf = readFileSync(join(REPO_ROOT, 'elasticmq.conf'), 'utf8');
  const block = conf.slice(conf.indexOf('queues {'));
  return [...block.matchAll(/^\s+([a-zA-Z][a-zA-Z0-9]*)\s*\{/gm)].map(m => m[1]).filter(n => n !== 'queues');
};

/** camelCase queue name to the SCREAMING_SNAKE env key, matching the shim's own toEnvKey. */
const envKey = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();

const templateEnvKeys = (): Set<string> => {
  const template = readFileSync(join(REPO_ROOT, '.env.selfhost.example'), 'utf8');
  return new Set([...template.matchAll(/^([A-Z0-9_]+)=/gm)].map(m => m[1]));
};

describe('self-host queue wiring stays consistent across its three files', () => {
  test('the parsers actually see something (guards against a silently empty scan)', () => {
    expect(manifestQueues().length).toBeGreaterThan(10);
    expect(brokerQueues().length).toBeGreaterThan(10);
    expect(templateEnvKeys().has('FAB_FILE_CHUNK_QUEUE')).toBe(true);
  });

  test('every queue in the manifest is declared in elasticmq.conf', () => {
    const declared = new Set(brokerQueues());
    const missing = manifestQueues().filter(q => !declared.has(q));
    expect(missing, `in the manifest but not declared in elasticmq.conf: ${missing.join(', ')}`).toEqual([]);
  });

  test('every queue in the manifest has a URL in .env.selfhost.example', () => {
    const keys = templateEnvKeys();
    const missing = manifestQueues().filter(q => !keys.has(envKey(q)));
    expect(missing, `in the manifest but absent from .env.selfhost.example: ${missing.join(', ')}`).toEqual([]);
  });

  test('every queue declared in elasticmq.conf has a URL in .env.selfhost.example', () => {
    const keys = templateEnvKeys();
    const missing = brokerQueues().filter(q => !keys.has(envKey(q)));
    expect(missing, `declared in elasticmq.conf but absent from .env.selfhost.example: ${missing.join(', ')}`).toEqual(
      []
    );
  });
});
