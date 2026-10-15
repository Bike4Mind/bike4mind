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
const readInfra = (file: string) => readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

const linkOf = (block: string) => cut(block, '  link: [', '\n  ],');
const environmentOf = (block: string) => cut(block, '  environment: {', '\n  },');

// Both agent executor definitions spread SHARED_AGENT_EXECUTOR_CONFIG, so pinning it covers both.
const PRODUCERS = [
  {
    name: 'chat completion service',
    block: cut(readInfra('chatCompletion.ts'), "new sst.aws.Service('ChatCompletion'", '\n});'),
  },
  {
    name: 'agent executor',
    block: cut(readInfra('agentExecutor.ts'), 'const SHARED_AGENT_EXECUTOR_CONFIG = {', '\n};'),
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
