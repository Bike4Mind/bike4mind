import { matchesGlob } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dlqTriageEvidencePermissions, dlqTriagePermissions } from '../dlqTriagePermissions';

afterEach(() => vi.unstubAllGlobals());
describe('DLQ triage read grants', () => {
  it('allows only stage-local DLQ names, not ordinary work queues', () => {
    vi.stubGlobal('$app', { name: 'app', stage: 'test' });
    vi.stubGlobal('$interpolate', (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => text + part + (values[index] ?? ''), '')
    );
    vi.stubGlobal('aws', {
      getPartitionOutput: () => ({ partition: 'aws' }),
      getRegionOutput: () => ({ name: 'region' }),
      getCallerIdentityOutput: () => ({ accountId: 'account' }),
    });
    const policy = dlqTriagePermissions();
    const matches = (name: string) =>
      policy.resources.some(resource => matchesGlob(name, String(resource).split(':').at(-1)!));
    expect(policy.actions).not.toContain('sqs:DeleteMessage');
    expect(matches('app-test-ordersQueueDLQ-Queue-suffix')).toBe(true);
    expect(matches('app-test-dlqTriageSweepDlq-Queue-suffix')).toBe(true);
    expect(matches('app-test-ordersQueue-Queue-suffix')).toBe(false);
    expect(matches('app-other-ordersQueueDLQ-Queue-suffix')).toBe(false);
    const evidence = dlqTriageEvidencePermissions();
    expect(evidence.flatMap(grant => grant.actions)).toEqual([
      'lambda:ListEventSourceMappings',
      'sqs:GetQueueAttributes',
      'logs:FilterLogEvents',
    ]);
    expect(evidence.slice(1).every(grant => String(grant.resources[0]).includes('app-test-'))).toBe(true);
    expect(evidence.find(grant => grant.actions.includes('logs:FilterLogEvents'))?.resources[0]).toContain(
      'log-group:/aws/lambda/app-test-'
    );
  });
  it('attaches function metadata reads only to exact consumers after both worker roles are registered', () => {
    const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const policy = read('dlqTriageFunctionLogs.ts');
    expect(policy).toContain("import './cron'");
    expect(policy).toContain("import './dlqAlarms'");
    expect(policy).toContain("import { dlqConsumerFunctionArns } from './web'");
    expect(policy).toContain("actions: ['lambda:GetFunctionConfiguration'], resources: dlqConsumerFunctionArns");
    expect(policy).not.toContain('*');
    expect(policy).toContain('dlqTriageRoleNames.forEach');
    expect(read('cron.ts')).toContain('dlqTriageRoleNames.push(sweep.nodes.function.nodes.role.name)');
    expect(read('dlqAlarms.ts')).toContain(
      'dlqTriageRoleNames.push(triageSubscription.apply(subscription => subscription.nodes.function.nodes.role.name))'
    );
    expect(read('index.ts')).toContain("export * from './dlqTriageFunctionLogs'");
  });
});
