// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../apiProbeDetector.ts', import.meta.url), 'utf8');
// Execute the actual declaration without loading the full SST app.
const declaration = source
  .slice(source.indexOf('export const apiProbeDetector ='), source.indexOf('if (apiProbeDetector &&'))
  .replace('export const', 'const');

function loadTarget(code = declaration) {
  const cron = vi.fn(function (_name: string, _args: Record<string, unknown>) {
    return {};
  });
  runInNewContext(code, {
    runsScheduledJobs: true,
    apiProbeDetectorDeadLetter: {
      sendPermission: { actions: ['sqs:SendMessage'], resources: ['probe-dlq'] },
      functionTarget: {},
      ruleTarget: { target: { deadLetterConfig: { arn: 'probe-dlq' } } },
    },
    serverLogGroupName: 'server-log-group',
    serverLogGroupArn: 'server-log-group-arn',
    sst: { aws: { Cron: cron } },
    lambdaVpc: {},
    allSecrets: [],
    DEFAULT_LAMBDA_ENVIRONMENT: {},
    $app: { stage: 'production' },
    $interpolate: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values),
  });
  expect(cron).toHaveBeenCalledOnce();
  const transform = cron.mock.calls[0]?.[1]?.transform as { target: Record<string, unknown> } | undefined;
  // SST sets a literal input on the rule target, which transform.target is merged over.
  return { input: '{}', ...transform?.target };
}

describe('api probe detector cron', () => {
  it('clears SST default input to preserve the ScheduledEvent carrying event.time', () => {
    const target = loadTarget();
    expect(target.input).toBeUndefined();
    expect(target.deadLetterConfig).toEqual({ arn: 'probe-dlq' });
  });

  it('fails when the input override is removed', () => {
    expect(declaration).toContain('input: undefined,');
    expect(loadTarget(declaration.replace('input: undefined,', '')).input).toBe('{}');
  });
});
