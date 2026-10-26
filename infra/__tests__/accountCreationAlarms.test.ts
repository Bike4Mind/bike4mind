import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  accountCreationAlarmArgs,
  accountCreationAlarmThreshold,
  emailRateQueries,
  emailRateThreshold,
} from '../accountCreationAlarmConfig';

describe('account creation alarms', () => {
  it.each([undefined, '', ' '])('is opt-in for %s', value => {
    expect(accountCreationAlarmThreshold(value, 'TEST')).toBeUndefined();
  });
  it.each(['0', '-1', 'NaN', 'Infinity', '1.5', '9007199254740992'])('rejects invalid settings %s', value => {
    expect(() => accountCreationAlarmThreshold(value, 'TEST')).toThrow('TEST');
  });
  it('uses hourly Maximum so duplicate census deliveries do not inflate a count', () => {
    expect(accountCreationAlarmThreshold(' 7 ', 'TEST')).toBe(7);
    expect(accountCreationAlarmArgs('SuccessfulSignups', 7)).toEqual({
      metricName: 'SuccessfulSignups',
      threshold: 7,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      period: 3600,
      statistic: 'Maximum',
      treatMissingData: 'notBreaching',
    });
  });
  it('wires monitored failure delivery and alarms to the existing notification topic', () => {
    const source = readFileSync(new URL('../accountCreationAlarms.ts', import.meta.url), 'utf8');
    expect(source).toContain('alarmActions: [dlqAlarmTopic.arn]');
    expect(source).toContain('deadLetterConfig: { targetArn: failures.arn }');
    expect(source).toContain('deadLetterConfig: { arn: failures.arn }');
    expect(source).toContain("metricName: 'CensusCompleted'");
    expect(source).toContain("treatMissingData: 'breaching'");
    expect(source).toContain("['dev', 'production']");
    const contract = JSON.parse(readFileSync(new URL('../deploy-contract.json', import.meta.url), 'utf8'));
    expect(contract.deployEnv).toEqual(
      expect.arrayContaining(['SIGNUP_ALARM_PER_HOUR', 'NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR'])
    );
  });
  it('isolates SES rates to the OTC configuration set and handles zero sends', () => {
    const queries = emailRateQueries('Bounce', 'synthetic-otc');
    expect(queries[0]).toEqual({
      id: 'rate',
      expression: 'IF(FILL(sent, 0) > 0, 100 * FILL(events, 0) / FILL(sent, 0), IF(FILL(events, 0) > 0, 100, 0))',
      returnData: true,
    });
    expect(queries[1]).toMatchObject({
      metric: { metricName: 'Send', dimensions: { 'ses:configuration-set': 'synthetic-otc' } },
    });
    expect(queries[2]).toMatchObject({
      metric: { metricName: 'Bounce', dimensions: { 'ses:configuration-set': 'synthetic-otc' } },
    });
    expect(emailRateQueries('Complaint', 'synthetic-otc')[2]).toMatchObject({ metric: { metricName: 'Complaint' } });
    expect(emailRateThreshold(undefined, 'TEST')).toBeUndefined();
    expect(emailRateThreshold('0.5', 'TEST')).toBe(0.5);
    for (const invalid of ['0', '-1', '101', 'NaN', 'Infinity'])
      expect(() => emailRateThreshold(invalid, 'TEST')).toThrow('TEST');
  });
});
