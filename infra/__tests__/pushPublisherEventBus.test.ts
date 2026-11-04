/**
 * @vitest-environment node
 *
 * A push is published as an EventBridge event (NotificationEvents.Push reads
 * Resource.AppEventBus.name), so every compute whose handler calls publishPushNotification must
 * link eventBus. Without the link the publish throws, publishPushNotification swallows it at warn
 * (it must never fail the host path), and the push is silently dropped in every deployed stage.
 * Handler unit tests mock the publish, so only this guard catches a missing link.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Strip block comments so a commented-out entry cannot satisfy the assertions below.
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const readRepo = (file: string) => stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));

const PUBLISH_CALL = 'publishPushNotification(';

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

const linksEventBus = (block: string) => /\blink: \[[^\]]*\beventBus\b[^\]]*\]/.test(block);

// Every queue subscription in infra/queues.ts, cut at its column-0 `);`, paired with the worker
// module its handler string names. Discovered rather than listed, so a new subscriber whose
// handler publishes a push is covered without editing this file.
const QUEUE_SUBSCRIBERS = [
  ...readRepo('infra/queues.ts').matchAll(
    /\.subscribe\(\s*\{\s*handler: '(apps\/workers\/src\/queueHandlers\/\w+)\.\w+'([\s\S]*?)\n\);/g
  ),
].map(([, handlerModule, block]) => ({ handlerModule: `${handlerModule}.ts`, block }));

const PUSHING_QUEUE_SUBSCRIBERS = QUEUE_SUBSCRIBERS.filter(
  ({ handlerModule }) =>
    existsSync(path.join(REPO_ROOT, handlerModule)) && readRepo(handlerModule).includes(PUBLISH_CALL)
);

describe('push publishers link the event bus', () => {
  it('discovers the queue subscribers that publish pushes', () => {
    // Pins the discovery itself: a regex that stopped matching would pass every case below vacuously.
    expect(PUSHING_QUEUE_SUBSCRIBERS.map(({ handlerModule }) => path.basename(handlerModule, '.ts'))).toEqual(
      expect.arrayContaining(['imageGeneration', 'imageEdit', 'agentProactiveMessage', 'generationJob'])
    );
  });

  it.each(PUSHING_QUEUE_SUBSCRIBERS)('$handlerModule links eventBus', ({ block }) => {
    expect(linksEventBus(block)).toBe(true);
  });

  it('the agent executor links eventBus', () => {
    expect(readRepo('apps/workers/src/queueHandlers/agentExecutor.ts')).toContain(PUBLISH_CALL);
    expect(
      linksEventBus(cut(readRepo('infra/agentExecutor.ts'), 'const SHARED_AGENT_EXECUTOR_CONFIG = {', '\n};'))
    ).toBe(true);
  });

  it('the chat completion service links eventBus', () => {
    expect(readRepo('apps/client/server/queueHandlers/questProcessor.ts')).toContain(PUBLISH_CALL);
    expect(
      linksEventBus(cut(readRepo('infra/chatCompletion.ts'), "new sst.aws.Service('ChatCompletion'", '\n});'))
    ).toBe(true);
  });
});
