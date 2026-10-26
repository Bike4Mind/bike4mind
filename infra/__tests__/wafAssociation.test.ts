/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExternalWafAssociation } from '../wafAssociation';

describe('resolveExternalWafAssociation', () => {
  it('returns the trimmed ACL name for production', () => {
    expect(
      resolveExternalWafAssociation({ stage: 'production', enableWaf: 'true', webAclName: ' bike4mind-acl ' })
    ).toEqual({ webAclName: 'bike4mind-acl' });
  });

  it.each([undefined, '', '   '])('throws in production when WAF_WEB_ACL_NAME is %j', webAclName => {
    expect(() => resolveExternalWafAssociation({ stage: 'production', enableWaf: 'true', webAclName })).toThrow(
      /WAF_WEB_ACL_NAME/
    );
  });

  it.each([undefined, '', 'false', 'TRUE'])('throws in production when ENABLE_WAF is %j', enableWaf => {
    expect(() => resolveExternalWafAssociation({ stage: 'production', enableWaf, webAclName: 'acl' })).toThrow(
      /ENABLE_WAF/
    );
  });

  it.each(['dev', 'staging', 'pr5655'])('leaves %s to own its ACL', stage => {
    expect(resolveExternalWafAssociation({ stage, enableWaf: 'true', webAclName: 'acl' })).toBeUndefined();
    expect(resolveExternalWafAssociation({ stage, enableWaf: undefined, webAclName: undefined })).toBeUndefined();
  });
});

const resources = vi.hoisted(() => {
  function output<T>(value: T): { arn?: T; apply: <Result>(callback: (input: T) => Result) => Result } {
    return { apply: callback => callback(value) };
  }
  const resource = vi.fn(function (name: string, args: Record<string, unknown>) {
    return { ...args, name: args.name ?? name, arn: output(`${name}-arn`), url: `${name}-url` };
  });
  const lookup = vi.fn((_args: Record<string, unknown>, _options: unknown) => ({ arn: output('looked-up-acl-arn') }));
  const topicLookup = vi.fn((_args: Record<string, unknown>, _options: unknown) => ({ arn: 'looked-up-topic-arn' }));
  return { output, resource, lookup, topicLookup };
});

vi.mock('../secrets', () => ({ secrets: { SLACK_ERROR_REPORTING_WEBHOOK_URL: 'webhook-secret' } }));
vi.mock('../constants', () => ({ DEFAULT_LAMBDA_ENVIRONMENT: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loadWaf(stage: string) {
  vi.resetModules();
  vi.stubEnv('ENABLE_WAF', 'true');
  vi.stubEnv('WAF_BLOCKED_IPS', '');
  vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com');
  vi.stubGlobal('$app', { name: 'test-app', stage });
  vi.stubGlobal('$util', { all: resources.output });
  vi.stubGlobal('$interpolate', (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '')
  );
  vi.stubGlobal('aws', {
    Provider: resources.resource,
    wafv2: {
      IpSet: resources.resource,
      WebAcl: resources.resource,
      WebAclLoggingConfiguration: resources.resource,
      getWebAclOutput: resources.lookup,
    },
    cloudwatch: { LogGroup: resources.resource, MetricAlarm: resources.resource },
    sns: { Topic: resources.resource, TopicSubscription: resources.resource, getTopicOutput: resources.topicLookup },
    lambda: { Permission: resources.resource },
    sqs: { Queue: resources.resource, QueuePolicy: resources.resource },
  });
  vi.stubGlobal('sst', { Linkable: resources.resource, aws: { Function: resources.resource } });
  return import('../waf');
}

const createdNames = () => resources.resource.mock.calls.map(([name]) => name);

describe('production WAF wiring', () => {
  it('looks the ACL up by name and creates only the alert delivery resources', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'bike4mind-api-protection-prod');
    const waf = await loadWaf('production');

    expect(resources.lookup).toHaveBeenCalledWith(
      { name: 'bike4mind-api-protection-prod', scope: 'CLOUDFRONT' },
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    expect(waf.wafWebAcl).toBeDefined();

    const names = createdNames();
    for (const owned of [
      'WafEmergencyIpBlockSet',
      'WafLogGroup',
      'WafWebAcl',
      'WafLoggingConfiguration',
      'WafAiRateLimitAlarmTopic',
      'wafAiRateLimitBlocks',
    ]) {
      expect(names, owned).not.toContain(owned);
    }
    expect(names.filter(n => /^waf-.*-blocks$/.test(String(n)))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        'WafAlarmSlackHandler',
        'WafAlarmSlackHandlerSnsPermission',
        'WafAlarmSlackHandlerDlq',
        'WafAlarmSlackHandlerDlqPolicy',
        'WafAlarmSlackHandlerSubscription',
        'WafOobAlarmTopic',
        'WafOobAlarmTopicEmailSub',
        'WafAlarmSlackHandlerDlqMessages',
        'WafAlarmSlackHandlerDlqAge',
      ])
    );
  });

  it('subscribes to the externally owned topic found by name', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'bike4mind-api-protection-prod');
    await loadWaf('production');

    const topicArn = 'looked-up-topic-arn';
    expect(resources.topicLookup).toHaveBeenCalledWith(
      { name: 'test-app-production-waf-ai-rate-limit-alarm' },
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    const call = (name: string) => resources.resource.mock.calls.find(([n]) => n === name)![1];
    expect(call('WafAlarmSlackHandlerSubscription')).toMatchObject({ topic: topicArn });
    expect(call('WafAlarmSlackHandlerSnsPermission')).toMatchObject({ sourceArn: topicArn });
  });

  it('fails closed when the ACL name is missing', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', '');
    await expect(loadWaf('production')).rejects.toThrow(/WAF_WEB_ACL_NAME/);
    expect(resources.lookup).not.toHaveBeenCalled();
  });
});

describe('non-production WAF wiring', () => {
  it('keeps creating a stage-owned ACL and does not look anything up', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', '');
    await loadWaf('pr5655');

    expect(createdNames()).toEqual(
      expect.arrayContaining(['WafEmergencyIpBlockSet', 'WafLogGroup', 'WafWebAcl', 'WafLoggingConfiguration'])
    );
    expect(createdNames()).not.toContain('WafAlarmSlackHandler');
    expect(resources.lookup).not.toHaveBeenCalled();
  });
});
