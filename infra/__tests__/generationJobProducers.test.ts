/**
 * @vitest-environment node
 *
 * Every compute that runs the music/video tools enqueues a generation job, so it must link
 * generationJobQueue directly (resolveGenerationJobQueueUrl in
 * apps/client/server/generationJobs/wiring.ts; the sourceQueueUrls fallback is web-only) and carry
 * the test providers so keyless non-production stages still offer those tools.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Strip block comments so a commented-out entry cannot satisfy the assertions below.
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
};

const linkOf = (block: string) => cut(block, '\n  link: [', '\n  ],');
const environmentOf = (block: string) => cut(block, '\n  environment: {', '\n  },');

const PRODUCERS = [
  {
    name: 'chat completion service',
    block: cut(readInfra('chatCompletion.ts'), "new sst.aws.Service('ChatCompletion'", '\n});'),
  },
  {
    name: 'agent executor',
    block: cut(readInfra('agentExecutor.ts'), 'const SHARED_AGENT_EXECUTOR_CONFIG = {', '\n};'),
  },
  {
    name: 'slack quest processor',
    block: cut(readInfra('functions.ts'), "new sst.aws.Function('SlackQuestProcessor'", '\n});'),
  },
];

describe.each(PRODUCERS)('$name as a generation job producer', ({ block }) => {
  it('links generationJobQueue directly', () => {
    expect(linkOf(block)).toMatch(/^\s+generationJobQueue,$/m);
  });

  it('registers the test generation providers', () => {
    expect(environmentOf(block)).toMatch(/^\s+\.\.\.TEST_GENERATION_PROVIDER_ENVIRONMENT,$/m);
  });
});

// Both agent executor definitions spread SHARED_AGENT_EXECUTOR_CONFIG, and a consumer that sets
// its own link/environment after the spread would silently drop the queue link and test providers.
const AGENT_EXECUTOR_CONSUMERS = [
  {
    name: 'agent executor function',
    block: cut(readInfra('agentExecutor.ts'), "new sst.aws.Function('AgentExecutor'", '\n});'),
  },
  {
    name: 'continuation queue subscription',
    block: cut(readInfra('agentExecutor.ts'), 'agentContinuationQueue.subscribe(', '\n);'),
  },
];

describe.each(AGENT_EXECUTOR_CONSUMERS)('$name', ({ block }) => {
  it('spreads SHARED_AGENT_EXECUTOR_CONFIG without overriding link or environment', () => {
    expect(block).toMatch(/^\s+\.\.\.SHARED_AGENT_EXECUTOR_CONFIG,$/m);
    expect(block).not.toMatch(/^\s+(link|environment):/m);
  });
});
