/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 *
 * The publish thumbnail renderer runs author-supplied pages, so it is deployed as its own function
 * with no application credentials or permissions, and only the queue handler may invoke it. These
 * pin both halves of that split (see the Publish Thumbnail Queue block in infra/queues.ts).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const QUEUES = read('infra/queues.ts');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, `start marker ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `end marker after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

const RENDERER = cut(
  QUEUES,
  "const publishThumbnailRenderer = new sst.aws.Function('PublishThumbnailRenderer'",
  '\n});'
);
const ORCHESTRATOR = cut(QUEUES, 'const publishThumbnailQueueSubscription = publishThumbnailQueue.subscribe(', '\n);');
const QUEUE = cut(QUEUES, "const publishThumbnailQueue = new sst.aws.Queue('publishThumbnailQueue'", '\n});');

/** Top-level keys of the renderer's args object (two-space indent inside the constructor call). */
const rendererKeys = () => [...RENDERER.matchAll(/^ {2}([A-Za-z]+):/gm)].map(match => match[1]);

describe('publish thumbnail renderer function', () => {
  it('declares only its code, fonts, runtime and sizing: no link, secrets, VPC, environment, permissions or role', () => {
    expect(rendererKeys().sort()).toEqual(['copyFiles', 'handler', 'memory', 'nodejs', 'runtime', 'timeout']);
    // No layers either: an extension runs as its own process, which every render's clean-environment
    // check (apps/workers/src/media/renderEnvironment.ts) would refuse.
    for (const forbidden of ['link', 'allSecrets', 'vpc', 'environment', 'permissions', 'role', 'url', 'layers']) {
      expect(RENDERER).not.toMatch(new RegExp(`\\b${forbidden}\\b\\s*:`));
    }
    expect(RENDERER).not.toMatch(/allSecrets|DEFAULT_LAMBDA_ENVIRONMENT|Bucket\b/);
  });

  it('points at the minimal handler and ships the browser packages unbundled', () => {
    expect(RENDERER).toMatch(/handler:\s*'apps\/workers\/src\/media\/publishThumbnailRenderer\.handler'/);
    expect(RENDERER).toMatch(/install:\s*\['@sparticuz\/chromium', 'playwright-core', 'sharp'\]/);
  });

  it('ships fallback symbol fonts where the packaged browser looks for them', () => {
    // /var/task/fonts is one of the directories in @sparticuz/chromium's bundled fonts.conf.
    expect(RENDERER).toMatch(/copyFiles:\s*\[\{\s*from:\s*'apps\/workers\/src\/media\/fonts',\s*to:\s*'fonts'\s*\}\]/);
    const files = readdirSync(path.join(REPO_ROOT, 'apps/workers/src/media/fonts'));
    expect(files.filter(name => name.endsWith('.ttf')).sort()).toEqual([
      'NotoSansMath-Regular.ttf',
      'NotoSansSymbols-Regular.ttf',
      'NotoSansSymbols2-Regular.ttf',
    ]);
    expect(files).toContain('OFL.txt');
  });

  it('times out before the orchestrator gives up on the invoke', () => {
    const rendererSeconds = Number(RENDERER.match(/timeout:\s*'(\d+) seconds'/)?.[1]);
    const invokeMs = Number(
      read('apps/workers/src/media/invokeThumbnailRenderer.ts')
        .match(/THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS = ([\d_]+);/)?.[1]
        .replace(/_/g, '')
    );
    expect(rendererSeconds * 1000).toBeLessThan(invokeMs);
  });
});

describe('publish thumbnail orchestrator (queue handler)', () => {
  it('is the only holder of invoke on the renderer, scoped to that one function', () => {
    expect(ORCHESTRATOR).toMatch(
      /permissions:\s*\[\{\s*actions:\s*\['lambda:InvokeFunction'\],\s*resources:\s*\[publishThumbnailRenderer\.arn\]\s*\}\]/
    );
    expect(ORCHESTRATOR).toMatch(/PUBLISH_THUMBNAIL_RENDERER_FUNCTION:\s*publishThumbnailRenderer\.name/);
    const elsewhere = QUEUES.replace(RENDERER, '').replace(ORCHESTRATOR, '');
    expect(elsewhere).not.toMatch(/publishThumbnailRenderer\.(arn|name)/);
    expect(elsewhere).not.toMatch(/link:\s*\[[^\]]*publishThumbnailRenderer/);
  });

  it('keeps the data access and the capped fan-out, and no longer packages a browser', () => {
    expect(ORCHESTRATOR).toMatch(/handler:\s*'apps\/workers\/src\/queueHandlers\/publishThumbnail\.dispatch'/);
    expect(ORCHESTRATOR).toMatch(/link:\s*\[\.\.\.allSecrets,\s*publishedArtifactsBucket\]/);
    expect(ORCHESTRATOR).toMatch(/maximumConcurrency:\s*5\b/);
    expect(ORCHESTRATOR).toMatch(/SINGLE_RECORD_BATCH/);
    expect(ORCHESTRATOR).not.toMatch(/@sparticuz\/chromium|playwright-core/);
  });

  it('holds each message for longer than the handler can run', () => {
    const handlerSeconds = Number(ORCHESTRATOR.match(/timeout:\s*'(\d+) seconds'/)?.[1]);
    const visibilityMinutes = Number(QUEUE.match(/visibilityTimeout:\s*'(\d+) minutes'/)?.[1]);
    const invokeMs = Number(
      read('apps/workers/src/media/invokeThumbnailRenderer.ts')
        .match(/THUMBNAIL_RENDERER_INVOKE_TIMEOUT_MS = ([\d_]+);/)?.[1]
        .replace(/_/g, '')
    );
    expect(handlerSeconds * 1000).toBeGreaterThan(invokeMs);
    expect(visibilityMinutes * 60).toBeGreaterThan(handlerSeconds);
  });
});

describe('publish thumbnail monitoring', () => {
  it('forwards both functions to the log monitor and alarms on the queue DLQ', () => {
    const logMonitor = read('infra/logMonitor.ts');
    expect(logMonitor).toMatch(/publishThumbnailQueueSubscription\.nodes\.function\.nodes\.logGroup/);
    expect(logMonitor).toMatch(/publishThumbnailRenderer\.nodes\.logGroup/);
    expect(read('infra/dlqAlarms.ts')).toMatch(/sourceQueue:\s*'publishThumbnailQueue'/);
  });
});
