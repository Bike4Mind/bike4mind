import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Guard on the "Ingest QA run to production" step in the two E2E workflows (scripts/qa-report.mjs).
 *
 * The step posts the same run to production's /status after the staging ingest. Each property
 * below fails silently if a later edit drops it, so they are pinned here:
 * - `continue-on-error`: a prod outage must never turn a green run red.
 * - last in the job: a slow prod must not delay the Slack post, the promotion stamp or the
 *   latency gate that come before it.
 * - the prod key and URL, never the staging pair: swapping them posts prod runs to staging.
 * - no `--counts-out` (e2e-run): the Slack count comparison reads the staging ingest's file.
 * - `QA_LATENCY_BREACH` (e2e-ai-latency): without it prod stores a breached latency run as passing.
 *
 * Text-matched rather than YAML-parsed, matching `checkE2ePreviewSecretGuard.test.ts`: the repo has
 * no YAML parser dependency and the assertions are about the literal step text. Each assertion is
 * bounded to the step's own block so a neighbouring step cannot satisfy it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', file), 'utf8');

const PROD_STEP_NAME = 'Ingest QA run to production';

type Step = { name: string; text: string };

/** Every `- name:` step in the file, each running up to the next step at the same indent. */
function readSteps(contents: string): Step[] {
  const lines = contents.split(/\r?\n/);
  const starts = lines.flatMap((line, index) => (/^ {6}- name: /.test(line) ? [index] : []));
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const text = lines.slice(start, end).join('\n');
    return { name: lines[start].replace(/^ {6}- name: /, '').trim(), text };
  });
}

function prodStep(steps: Step[]): Step {
  const matches = steps.filter(step => step.name === PROD_STEP_NAME);
  expect(matches).toHaveLength(1);
  return matches[0];
}

const WORKFLOWS = [
  // Steps that must run before the prod ingest: the surfaces a slow prod must not delay.
  {
    file: 'e2e-run.yml',
    mustPrecede: ['Compare QA counts with the Slack summary (shadow)', 'Post e2e commit status', 'Notify Slack'],
  },
  {
    file: 'e2e-ai-latency.yml',
    mustPrecede: [
      'Ingest QA run (shadow)',
      'Send Slack notification',
      'Send Slack alert for latency threshold breach',
      'Fail the run on a latency breach',
    ],
  },
];

describe.each(WORKFLOWS)('prod QA ingest step in $file', ({ file, mustPrecede }) => {
  const steps = readSteps(read(file));
  const step = prodStep(steps);

  it('never fails the run and skips when the prod URL is unset', () => {
    expect(step.text).toMatch(/^\s+continue-on-error: true$/m);
    expect(step.text).toMatch(/^\s+if: .*vars\.QA_INGEST_URL_PROD != ''/m);
  });

  it('posts with the prod URL and key, never the staging pair', () => {
    expect(step.text).toMatch(/^\s+QA_INGEST_URL: \$\{\{ vars\.QA_INGEST_URL_PROD \}\}$/m);
    expect(step.text).toMatch(/^\s+QA_INGEST_KEY: \$\{\{ secrets\.QA_INGEST_KEY_PROD \}\}$/m);
  });

  it.each(mustPrecede)('runs after "%s" so a slow prod cannot delay it', before => {
    const names = steps.map(s => s.name);
    expect(names).toContain(before);
    expect(names.indexOf(PROD_STEP_NAME)).toBeGreaterThan(names.indexOf(before));
  });
});

describe('prod QA ingest step: per-workflow properties', () => {
  it('e2e-run.yml does not overwrite the staging counts the Slack comparison reads', () => {
    const steps = readSteps(read('e2e-run.yml'));
    expect(prodStep(steps).text).not.toContain('--counts-out');
    // The pairing the omission relies on: the staging ingest is the one that writes them.
    const staging = steps.find(step => step.name === 'Ingest QA run (shadow)');
    expect(staging?.text).toContain('--counts-out qa-counts.json');
  });

  it('e2e-ai-latency.yml carries the latency verdict the staging ingest carries', () => {
    const steps = readSteps(read('e2e-ai-latency.yml'));
    const staging = steps.find(step => step.name === 'Ingest QA run (shadow)');
    const expected = /^\s+QA_LATENCY_BREACH: \$\{\{ steps\.aggregate\.outputs\.latency_breach \}\}$/m;
    expect(staging?.text).toMatch(expected);
    expect(prodStep(steps).text).toMatch(expected);
  });
});
