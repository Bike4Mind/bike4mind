/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExternalWafAssociation, resolveWafLabelForwarding, resolveWafLogDestination } from '../wafAssociation';

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

  it.each(['dev', 'staging', 'pr5655'])('attaches the external ACL on %s when a name is set', stage => {
    expect(resolveExternalWafAssociation({ stage, enableWaf: 'true', webAclName: 'acl' })).toEqual({
      webAclName: 'acl',
    });
  });

  it.each(['dev', 'staging', 'pr5655'])('leaves %s to own its ACL when no name is set', stage => {
    expect(resolveExternalWafAssociation({ stage, enableWaf: 'true', webAclName: undefined })).toBeUndefined();
    expect(resolveExternalWafAssociation({ stage, enableWaf: 'true', webAclName: '  ' })).toBeUndefined();
    expect(resolveExternalWafAssociation({ stage, enableWaf: undefined, webAclName: undefined })).toBeUndefined();
  });

  it('ignores a name on a non-production stage when ENABLE_WAF is not true', () => {
    expect(resolveExternalWafAssociation({ stage: 'dev', enableWaf: 'false', webAclName: 'acl' })).toBeUndefined();
  });
});

describe('resolveWafLabelForwarding', () => {
  it.each([undefined, 'false', 'true'])(
    'forwards on the stage-owned ACL regardless of WAF_LABEL_FORWARDING=%j',
    flag => {
      expect(resolveWafLabelForwarding({ attachedAcl: 'stage', labelForwarding: flag })).toBe(true);
    }
  );

  it('forwards on an external ACL only when the deployer vouches for its rules', () => {
    expect(resolveWafLabelForwarding({ attachedAcl: 'external', labelForwarding: 'true' })).toBe(true);
    for (const flag of [undefined, '', 'false', 'TRUE', '1']) {
      expect(resolveWafLabelForwarding({ attachedAcl: 'external', labelForwarding: flag })).toBe(false);
    }
  });

  it('never forwards without an attached ACL', () => {
    expect(resolveWafLabelForwarding({ attachedAcl: 'none', labelForwarding: 'true' })).toBe(false);
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
  const loggingRead = vi.fn((_name: string, _arn: unknown, _state: unknown, _options: unknown) => ({
    logDestinationConfigs: {
      apply: <Result>(callback: (value: string[]) => Result) =>
        output(callback(['arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-custom:*'])),
    },
  }));
  Object.assign(resource, { get: loggingRead });
  return { output, resource, lookup, topicLookup, loggingRead };
});

vi.mock('../secrets', () => ({ secrets: { SLACK_ERROR_REPORTING_WEBHOOK_URL: 'webhook-secret' } }));
vi.mock('../constants', () => ({ DEFAULT_LAMBDA_ENVIRONMENT: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loadWaf(stage: string, enableWaf = 'true') {
  vi.resetModules();
  vi.stubEnv('ENABLE_WAF', enableWaf);
  vi.stubEnv('WAF_BLOCKED_IPS', '');
  vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com');
  vi.stubGlobal('$app', { name: 'test-app', stage });
  vi.stubGlobal('$util', { all: resources.output });
  vi.stubGlobal('$interpolate', (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ''), '')
  );
  vi.stubGlobal('aws', {
    getCallerIdentityOutput: () => ({ accountId: 'deployment-account' }),
    getPartitionOutput: () => ({ partition: 'test' }),
    Provider: resources.resource,
    wafv2: {
      IpSet: resources.resource,
      WebAcl: resources.resource,
      WebAclLoggingConfiguration: resources.resource,
      getWebAclOutput: resources.lookup,
    },
    cloudwatch: {
      LogGroup: resources.resource,
      MetricAlarm: resources.resource,
      LogMetricFilter: resources.resource,
    },
    sns: { Topic: resources.resource, TopicSubscription: resources.resource, getTopicOutput: resources.topicLookup },
    lambda: { Permission: resources.resource },
    ssm: { Parameter: resources.resource },
    sqs: { Queue: resources.resource, QueuePolicy: resources.resource },
  });
  vi.stubGlobal('sst', { Linkable: resources.resource, aws: { Function: resources.resource } });
  return import('../waf');
}

const createdNames = () => resources.resource.mock.calls.map(([name]) => name);
/** Created by waf.ts on every monitored stage, independent of the WAF alert delivery resources. */
const NON_WAF_NAMES = new Set(['waf-us-east-1', 'WafWebAclArn', 'AlarmSlackMention']);

describe('production WAF wiring', () => {
  it('looks the ACL up by name and creates only the alert delivery resources', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    const waf = await loadWaf('production');

    expect(resources.lookup).toHaveBeenCalledWith(
      { name: 'custom-firewall', scope: 'CLOUDFRONT' },
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    expect(waf.wafWebAcl).toBeDefined();
    expect(resources.loggingRead).toHaveBeenCalledWith(
      'ExternalWafLoggingConfiguration',
      waf.wafWebAcl?.arn,
      undefined,
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    expect(waf.wafReadPermissions).toEqual([
      {
        actions: ['logs:StartQuery', 'logs:GetQueryResults'],
        resources: ['arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-custom:*'],
      },
      { actions: ['logs:StopQuery'], resources: ['*'] },
      { actions: ['wafv2:GetLoggingConfiguration'], resources: [waf.wafWebAcl?.arn] },
    ]);

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

describe('non-production WAF wiring with an external ACL', () => {
  it('attaches the looked-up ACL and creates no alert delivery resources or topic lookups', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'bike4mind-api-protection-staging');
    const waf = await loadWaf('dev');

    expect(resources.lookup).toHaveBeenCalledWith(
      { name: 'bike4mind-api-protection-staging', scope: 'CLOUDFRONT' },
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    expect(waf.wafWebAcl).toBeDefined();
    expect(resources.loggingRead).toHaveBeenCalledWith(
      'ExternalWafLoggingConfiguration',
      waf.wafWebAcl?.arn,
      undefined,
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    expect(waf.wafReadPermissions).toEqual([
      {
        actions: ['logs:StartQuery', 'logs:GetQueryResults'],
        resources: ['arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-custom:*'],
      },
      { actions: ['logs:StopQuery'], resources: ['*'] },
      { actions: ['wafv2:GetLoggingConfiguration'], resources: [waf.wafWebAcl?.arn] },
    ]);
    expect(resources.topicLookup).not.toHaveBeenCalled();
    expect(createdNames().filter(n => !NON_WAF_NAMES.has(String(n)))).toEqual([]);
  });
});

describe('non-production WAF wiring', () => {
  it('keeps creating a stage-owned ACL and does not look anything up', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', '');
    const waf = await loadWaf('pr5655');
    expect(waf.wafReadPermissions[0].resources).toEqual(['WafLogGroup-arn:*']);
    expect(resources.loggingRead).not.toHaveBeenCalled();

    expect(createdNames()).toEqual(
      expect.arrayContaining(['WafEmergencyIpBlockSet', 'WafLogGroup', 'WafWebAcl', 'WafLoggingConfiguration'])
    );
    expect(createdNames()).not.toContain('WafAlarmSlackHandler');
    expect(resources.lookup).not.toHaveBeenCalled();
  });
});

describe('WAF label forwarding wiring', () => {
  it('stays off for the production external ACL until the deployer sets WAF_LABEL_FORWARDING', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    vi.stubEnv('WAF_LABEL_FORWARDING', '');
    expect((await loadWaf('production')).wafLabelForwarding).toBe(false);
  });

  it('turns on for the production external ACL with WAF_LABEL_FORWARDING=true', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    vi.stubEnv('WAF_LABEL_FORWARDING', 'true');
    expect((await loadWaf('production')).wafLabelForwarding).toBe(true);
  });

  it('is on for a stage-owned ACL and off with WAF disabled', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', '');
    vi.stubEnv('WAF_LABEL_FORWARDING', '');
    expect((await loadWaf('pr5655')).wafLabelForwarding).toBe(true);
    vi.stubEnv('WAF_LABEL_FORWARDING', 'true');
    expect((await loadWaf('pr5655', 'false')).wafLabelForwarding).toBe(false);
  });
});

describe('external logging destination', () => {
  it.each(['', ':*'])('accepts a custom CloudWatch group with suffix %j', suffix => {
    const arn = 'arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-custom';
    expect(resolveWafLogDestination([arn + suffix])).toEqual({ arn, name: 'aws-waf-logs-custom' });
  });

  it.each([
    [],
    ['arn:test:s3:::aws-waf-logs-custom'],
    ['arn:test:logs:eu-west-1:deployment-account:log-group:aws-waf-logs-custom'],
    ['arn:test:logs:us-east-1:deployment-account:log-group:unrelated'],
    [
      'arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-one',
      'arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-two',
    ],
  ])('rejects unsupported logging destinations %j', (...destinations) => {
    expect(() => resolveWafLogDestination(destinations)).toThrow(/CloudWatch log group/);
  });

  it('propagates a failed logging lookup', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    resources.loggingRead.mockImplementationOnce(() => {
      throw new Error('logging lookup denied');
    });
    await expect(loadWaf('production')).rejects.toThrow('logging lookup denied');
  });

  it('propagates a failed production alarm topic lookup', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    resources.topicLookup.mockImplementationOnce(() => {
      throw new Error('alarm topic not found');
    });
    await expect(loadWaf('production')).rejects.toThrow('alarm topic not found');
  });

  it('propagates a failed ACL lookup', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    resources.lookup.mockImplementationOnce(() => {
      throw new Error('ACL not found');
    });
    await expect(loadWaf('production')).rejects.toThrow('ACL not found');
  });

  it('preserves shared-router dashboard permissions without local WAF lookups', async () => {
    vi.stubEnv('WAF_WEB_ACL_NAME', 'custom-firewall');
    const waf = await loadWaf('dev', 'false');
    expect(waf.wafReadPermissions).toEqual([
      {
        actions: ['logs:StartQuery', 'logs:GetQueryResults'],
        resources: ['arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-bike4mind-*'],
      },
      { actions: ['logs:StopQuery'], resources: ['*'] },
      {
        actions: ['wafv2:GetLoggingConfiguration'],
        resources: ['arn:test:wafv2:us-east-1:deployment-account:global/webacl/bike4mind-api-protection-*'],
      },
    ]);
    expect(resources.lookup).not.toHaveBeenCalled();
    expect(resources.loggingRead).not.toHaveBeenCalled();
    expect(createdNames().filter(n => !NON_WAF_NAMES.has(String(n)))).toEqual([]);
  });
});
