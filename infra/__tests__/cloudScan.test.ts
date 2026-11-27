// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const cron = read('infra/cron.ts');
const web = read('infra/web.ts');

describe('manual cloud scan dispatch boundary', () => {
  it('uses the same always-available worker for manual and scheduled scans', () => {
    expect(cron).toContain("const cloudSecurityScanFunction = new sst.aws.Function('cloudSecurityScanFunction'");
    expect(cron).toContain("handler: 'apps/workers/src/security/cloudScan.handler'");
    expect(cron).toMatch(/cloudSecurityScanCron = runsScheduledJobs[\s\S]*?job: cloudSecurityScanFunction\.arn/);
    expect(web).toContain('cloudSecurityScan: cloudSecurityScanFunction.name');
    expect(web).toMatch(
      /actions: \['lambda:InvokeFunction'\],[\s\S]*?resources: \[[^\]]*cloudSecurityScanFunction\.arn/
    );
  });

  it('links triage and retains async failures on both delivery legs', () => {
    const worker = cron.slice(
      cron.indexOf('const cloudSecurityScanFunction'),
      cron.indexOf('const cloudSecurityScanCron')
    );
    expect(worker).toContain('link: [...allSecrets, secopsTriageQueue]');
    expect(worker).toContain('transform: cloudSecurityScanDeadLetter.functionTarget');
    expect(worker).toContain('cloudSecurityScanDeadLetter.sendPermission');
    expect(cron).toContain('transform: { target: cloudSecurityScanDeadLetter.ruleTarget.target }');
    expect(cron).toContain('cloudSecurityScanDeadLetter.allowRules');
    expect(read('apps/workers/src/security/cloudScan.ts')).toContain('QueueUrl: Resource.secopsTriageQueue.url');
    expect(read('infra/dlqAlarms.ts')).toContain('queue: cloudSecurityScanDeadLetter.queue');
  });

  it('keeps the cloud scan implementation and EC2 client outside the API route', () => {
    const route = read('apps/client/pages/api/admin/security-dashboard/cloud.ts');
    expect(route).not.toMatch(/security\/cloudScan|client-ec2|runCloudScan|client-sqs/);
    expect(route).toContain("InvocationType: 'Event'");
  });
});
