/**
 * @vitest-environment node
 *
 * Pins the refused-request burst alarm to the req-timing line the API server writes. With
 * treatMissingData 'notBreaching', a renamed field leaves the rule matching nothing and the alarm
 * OK forever while every other suite stays green.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DEFAULT_REFUSED_REQUEST_THRESHOLD_PER_15MIN,
  REFUSED_REQUEST_WINDOW_SECONDS,
  refusedRequestRuleDefinition,
  refusedRequestRuleName,
} from '../refusedRequestRules';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');
const ALARMS = read('infra/refusedRequestAlarms.ts');
const RELAY_INFRA = read('infra/dlqAlarms.ts');
const DETAIL = read('apps/workers/src/events/refusedRequestBurstDetail.ts');

describe('refused request rules', () => {
  it('reads the fields the req-timing middleware and the request logger write', () => {
    const baseApi = read('apps/client/server/middlewares/baseApi.ts');
    expect(baseApi).toContain(".info('req-timing')");
    expect(baseApi).toContain('status: res.statusCode,');
    expect(baseApi).toContain('...(req.user ? { userId: req.user.id } : {}),');
    const requestLogger = read('apps/client/server/middlewares/requestLogger.ts');
    expect(requestLogger).toContain('clientIp: getClientIp(req),');
    expect(requestLogger).toMatch(/^\s+path,$/m);
  });

  it('counts 401-405 for signed-out callers, keyed by client IP', () => {
    const rule = JSON.parse(refusedRequestRuleDefinition('/aws/lambda/server', 'by-ip'));
    expect(rule).toEqual({
      Schema: { Name: 'CloudWatchLogRule', Version: 1 },
      LogGroupNames: ['/aws/lambda/server'],
      LogFormat: 'JSON',
      Contribution: {
        Keys: ['$.clientIp'],
        Filters: [
          { Match: '$.message', In: ['req-timing'] },
          { Match: '$.status', GreaterThan: 400 },
          { Match: '$.status', LessThan: 406 },
          { Match: '$.userId', IsPresent: false },
        ],
      },
      AggregateOn: 'Count',
    });
  });

  it('gives the path rule the same filters with the path as a second key', () => {
    const byIp = JSON.parse(refusedRequestRuleDefinition('g', 'by-ip'));
    const byIpPath = JSON.parse(refusedRequestRuleDefinition('g', 'by-ip-path'));
    expect(byIpPath.Contribution.Keys).toEqual(['$.clientIp', '$.path']);
    expect(byIpPath.Contribution.Filters).toEqual(byIp.Contribution.Filters);
  });

  it('names rules per app and stage', () => {
    expect(refusedRequestRuleName('bike4mind', 'production', 'by-ip')).toBe(
      'bike4mind-production-refused-requests-by-ip'
    );
    expect(refusedRequestRuleName('bike4mind', 'dev', 'by-ip-path')).toBe('bike4mind-dev-refused-requests-by-ip-path');
  });
});

describe('refused request burst alarm', () => {
  it('alarms on the top IP over one 15-minute window', () => {
    expect(REFUSED_REQUEST_WINDOW_SECONDS).toBe(900);
    expect(ALARMS).toContain("INSIGHT_RULE_METRIC('${byIp.ruleName}', 'MaxContributorValue')");
    expect(ALARMS).toContain('period: REFUSED_REQUEST_WINDOW_SECONDS,');
    expect(ALARMS).toMatch(/evaluationPeriods: 1,/);
    expect(ALARMS).toMatch(/comparisonOperator: 'GreaterThanOrEqualToThreshold'/);
    expect(ALARMS).toMatch(/treatMissingData: 'notBreaching'/);
    expect(DETAIL).toContain(`REFUSED_REQUEST_WINDOW_SECONDS = ${REFUSED_REQUEST_WINDOW_SECONDS};`);
  });

  it('names the alarm by the catalog key the relay describes it with', () => {
    expect(ALARMS).toContain('name: `${$app.name}-${$app.stage}-refused-request-burst`');
    expect(read('apps/workers/src/events/alarmSlackMessage.ts')).toContain("detail: 'refused-request-burst',");
  });

  it('routes alarm and recovery to the alarm topic', () => {
    expect(ALARMS).toMatch(/alarmActions: \[dlqAlarmTopic\.arn\]/);
    expect(ALARMS).toMatch(/okActions: \[dlqAlarmTopic\.arn\]/);
  });

  it('reads a 100-per-15-minute default threshold from a declared deploy variable', () => {
    expect(DEFAULT_REFUSED_REQUEST_THRESHOLD_PER_15MIN).toBe(100);
    expect(ALARMS).toContain('process.env.REFUSED_REQUEST_BURST_ALARM_PER_15MIN');
    expect(JSON.parse(read('infra/deploy-contract.json')).deployEnv).toContain('REFUSED_REQUEST_BURST_ALARM_PER_15MIN');
  });

  it('lets the relay read both rules, by the env names the detail loader reads', () => {
    expect(RELAY_INFRA).toContain("REFUSED_REQUEST_IP_RULE: refusedRequestRules['by-ip'],");
    expect(RELAY_INFRA).toContain("REFUSED_REQUEST_IP_PATH_RULE: refusedRequestRules['by-ip-path'],");
    expect(RELAY_INFRA).toContain(
      "{ actions: ['cloudwatch:GetInsightRuleReport'], resources: refusedRequestRuleArns },"
    );
    expect(DETAIL).toContain("REFUSED_REQUEST_IP_RULE_ENV = 'REFUSED_REQUEST_IP_RULE';");
    expect(DETAIL).toContain("REFUSED_REQUEST_IP_PATH_RULE_ENV = 'REFUSED_REQUEST_IP_PATH_RULE';");
  });

  it('is exported before logMonitor', () => {
    const index = read('infra/index.ts');
    expect(index.indexOf("'./refusedRequestAlarms'")).toBeGreaterThan(-1);
    expect(index.indexOf("'./refusedRequestAlarms'")).toBeLessThan(index.indexOf("'./logMonitor'"));
  });
});
