/**
 * @vitest-environment node
 *
 * Guard for the email-send worker's transport wiring (infra/mailTransport.ts, infra/eventBus.ts):
 * the runtime flag and configuration set reach the worker, the SES grant rides on the same
 * function, and the grant is assembled from the deploying account rather than written down.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const mailTransport = read('infra/mailTransport.ts');
const eventBus = read('infra/eventBus.ts');
const contract = JSON.parse(read('infra/deploy-contract.json')) as { deployEnv: string[] };

const emailSendBlock = eventBus.slice(
  eventBus.indexOf("eventBus.subscribe(\n  'email-send',"),
  eventBus.indexOf('emailEventsDeadLetter.allowRules([emailSendSubscription]);')
);

describe('email-send worker mail transport wiring', () => {
  it('declares the deploy-time inputs in the contract', () => {
    expect(contract.deployEnv).toEqual(
      expect.arrayContaining(['MAIL_TRANSPORT', 'SES_CONFIGURATION_SET', 'SES_IDENTITY'])
    );
  });

  it('defaults the transport to smtp and normalises the flag the way the runtime does', () => {
    expect(mailTransport).toContain("process.env.MAIL_TRANSPORT?.trim().toLowerCase() === 'ses' ? 'ses' : 'smtp'");
  });

  it('refuses a ses deploy that names no identity or configuration set', () => {
    expect(mailTransport).toContain("if (mailTransport === 'ses' && (!sesConfigurationSet || !sesIdentity))");
  });

  it('builds the grant from the deploying account and region, never a literal account id', () => {
    expect(mailTransport).toContain('aws.getPartitionOutput().partition');
    expect(mailTransport).toContain('aws.getCallerIdentityOutput().accountId');
    expect(mailTransport).toContain('aws.getRegionOutput().name');
    expect(mailTransport).toContain(':ses:${region}:${accountId}:${suffix}');
    expect(mailTransport).toContain('sesArn(`identity/${sesIdentity}`)');
    expect(mailTransport).toContain('sesArn(`configuration-set/${sesConfigurationSet}`)');
    expect(mailTransport).not.toMatch(/:\d{12}:/);
  });

  it('scopes the grant to the two send actions and includes the OTC set when it exists', () => {
    expect(mailTransport).toContain("actions: ['ses:SendEmail', 'ses:SendRawEmail']");
    expect(mailTransport).toContain('otcEmailConfigurationSet ? [otcEmailConfigurationSet.arn] : []');
  });

  it('hands the flag, the set and the grant to the email-send subscriber only', () => {
    expect(emailSendBlock).toContain('...mailTransportEnvironment,');
    expect(emailSendBlock).toContain('permissions: [emailEventsDeadLetter.sendPermission, ...sesSendPermissions]');
    expect(eventBus.split('...sesSendPermissions').length - 1).toBe(1);
    expect(eventBus.split('...mailTransportEnvironment').length - 1).toBe(1);
  });

  it('sinks test.com mail on every stage but production, derived from the stage rather than a deploy var', () => {
    expect(eventBus).toContain("const mailSinkDomains = $app.stage === 'production' ? '' : 'test.com';");
    expect(emailSendBlock).toContain('MAIL_SINK_DOMAINS: mailSinkDomains,');
    expect(eventBus.split('MAIL_SINK_DOMAINS').length - 1).toBe(1);
    expect(eventBus).not.toMatch(/process\.env\.MAIL_SINK/);
    expect(contract.deployEnv).not.toContain('MAIL_SINK_DOMAINS');
  });
});
