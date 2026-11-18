// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Logger } from '../../b4m-core/observability/src/index';
import { ALARM_CATALOG } from '../../apps/workers/src/events/alarmSlackMessage';
import { SIDE_APP_MINT_OUR_FAULT_EVENT } from '../../packages/server-utils/src/auth/sideAppMintEvent';
import { matchesMessageFilterPattern } from './helpers/matchesMessageFilterPattern';

const resources = vi.hoisted(() => {
  function output<T>(value: T) {
    return { value, apply: <Result>(callback: (input: T) => Result) => output(callback(value)) };
  }
  return {
    output,
    filter: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
    alarm: vi.fn(function (_name: string, _args: Record<string, unknown>) {}),
  };
});

vi.mock('../web', () => ({
  web: { nodes: { server: resources.output({ nodes: { logGroup: { name: 'server-logs' } } }) } },
}));
vi.mock('../dlqAlarms', () => ({ dlqAlarmTopic: { arn: 'alarm-topic' } }));
vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

async function loadAlarms(stage = 'production') {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'test-app', stage });
  await import('../sideAppMintAlarms');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ENABLE_MONITORING', undefined);
  vi.stubGlobal('aws', { cloudwatch: { LogMetricFilter: resources.filter, MetricAlarm: resources.alarm } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('side app mint alarm', () => {
  it('keys the filter on the dedicated event message and the alarm on its metric', async () => {
    await loadAlarms();
    expect(resources.filter).toHaveBeenCalledWith(
      'sideAppMintOurFaultFilter',
      expect.objectContaining({
        pattern: `{ $.message = "${SIDE_APP_MINT_OUR_FAULT_EVENT}" }`,
        metricTransformation: expect.objectContaining({
          name: 'SideAppMintOurFault',
          namespace: 'test-app/production/SideApps',
        }),
      })
    );
    expect(resources.alarm).toHaveBeenCalledWith(
      'sideAppMintOurFault',
      expect.objectContaining({
        metricName: 'SideAppMintOurFault',
        namespace: 'test-app/production/SideApps',
        period: 300,
        evaluationPeriods: 3,
        datapointsToAlarm: 3,
        treatMissingData: 'notBreaching',
        alarmActions: ['alarm-topic'],
        okActions: ['alarm-topic'],
      })
    );
  });

  it('is named so the Slack relay finds its catalog entry', async () => {
    await loadAlarms();
    const args = resources.alarm.mock.calls[0][1] as { name: string };
    const key = args.name.replace('test-app-production-', '');
    expect(key).toBe('side-app-mint-our-fault');
    expect(ALARM_CATALOG[key]).toBeDefined();
    expect(ALARM_CATALOG[key].title).not.toBe('');
  });

  it('is not created on unmonitored stages', async () => {
    await loadAlarms('someone');
    expect(resources.filter).not.toHaveBeenCalled();
    expect(resources.alarm).not.toHaveBeenCalled();
  });

  it('matches a real JSON logger line carrying the event, and nothing that merely mentions it', async () => {
    await loadAlarms();
    const pattern = resources.filter.mock.calls[0][1].pattern as string;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const logger = new Logger({ logInJson: true, prettyPrint: false, minLevel: 'warn' });
      logger.warn(SIDE_APP_MINT_OUR_FAULT_EVENT, { route: 'oauth/ai-token', status: 500 });
      logger.warn('[OAUTH_ERROR] route=oauth/ai-token client=x error=server_error status=500');
      logger.warn('other', { note: SIDE_APP_MINT_OUR_FAULT_EVENT });
      const prefix = '2026-11-18T00:00:00.000Z request-id WARN ';
      const lines = warn.mock.calls.map(([line]) => prefix + String(line));
      expect(lines).toHaveLength(3);
      expect(lines.map(line => matchesMessageFilterPattern(pattern, line))).toEqual([true, false, false]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('side app health alerts cron infra', () => {
  const source = readFileSync(new URL('../sideAppHealthAlerts.ts', import.meta.url), 'utf8');
  const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8')) as {
    envVars?: string[];
  };

  it('runs hourly behind runsScheduledJobs with a dead-letter queue and an enabled flag', () => {
    expect(source).toContain('runsScheduledJobs');
    expect(source).toContain("schedule: 'cron(15 * * * ? *)'");
    expect(source).toContain("process.env.SIDE_APP_HEALTH_ALERTS_ENABLED === 'true'");
    expect(source).toContain('deadLetter.sendPermission');
    expect(source).toContain('apps/workers/src/cron/sideAppHealthAlerts.handler');
  });

  it('registers the enabled flag in the deploy contract and the queue with the DLQ alarms and the cron loader', () => {
    expect(JSON.stringify(contract)).toContain('"SIDE_APP_HEALTH_ALERTS_ENABLED"');
    expect(readFileSync(new URL('../dlqAlarms.ts', import.meta.url), 'utf8')).toMatch(
      /label: 'side-app-health-alerts'[\s\S]*queue: sideAppHealthAlertsDLQ/
    );
    expect(readFileSync(new URL('../cron.ts', import.meta.url), 'utf8')).toContain("import './sideAppHealthAlerts';");
    expect(readFileSync(new URL('../index.ts', import.meta.url), 'utf8')).toContain(
      "export * from './sideAppMintAlarms';"
    );
  });
});
