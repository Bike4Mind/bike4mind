import { describe, it, expect } from 'vitest';
import { WebhookAuditStatus } from '@bike4mind/common';
import {
  DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW,
  WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS,
  webhookAuditLogsViewFromSearch,
  webhookAuditLogsViewToSearch,
  type WebhookAuditLogsView,
} from './webhookAuditLogsTabSearch';

const parsers = WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS;

const withoutUndefined = (search: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(search).filter(([, value]) => value !== undefined));

describe('the webhook audit log params', () => {
  it.each([
    ['webhookRange', '30d'],
    ['webhookEvent', 'pull_request'],
    ['webhookStatus', WebhookAuditStatus.Failed],
    ['webhookSource', 'org'],
    ['webhookRepo', 'acme/widgets'],
  ] as const)('accepts a valid %s', (key, value) => {
    expect(parsers[key](value)).toBe(value);
  });

  it.each([
    ['webhookRange', '1y'],
    ['webhookRange', 7],
    ['webhookEvent', 'deployment'],
    ['webhookStatus', 'FAILED'],
    ['webhookSource', 'team'],
    ['webhookRepo', ''],
    ['webhookRepo', '   '],
    ['webhookRepo', 'x'.repeat(141)],
    ['webhookRepo', ['acme/widgets']],
  ] as const)('rejects %s=%j', (key, value) => {
    expect(parsers[key](value)).toBeUndefined();
  });

  it('trims the repository', () => {
    expect(parsers.webhookRepo('  acme/widgets ')).toBe('acme/widgets');
  });

  describe('webhookDeliveryId', () => {
    it('accepts a delivery GUID', () => {
      expect(parsers.webhookDeliveryId('8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a')).toBe(
        '8f1c2e40-1d2b-11ef-9a3c-5b1e2d3c4f5a'
      );
    });

    // It is interpolated into the detail API's path.
    it.each([['../users'], ['a/b'], ['a?b=1'], ['a.b'], [''], ['x'.repeat(129)], [42]])('rejects %j', value => {
      expect(parsers.webhookDeliveryId(value)).toBeUndefined();
    });
  });
});

describe('webhookAuditLogsViewFromSearch', () => {
  it('is the default view for a bare URL', () => {
    expect(webhookAuditLogsViewFromSearch({})).toEqual(DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW);
  });

  it('falls back to the default for each invalid param', () => {
    expect(
      webhookAuditLogsViewFromSearch({ webhookRange: 'forever', webhookStatus: 'nope', webhookEvent: 'push' })
    ).toEqual({ ...DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW, event: 'push' });
  });
});

describe('webhookAuditLogsViewToSearch', () => {
  it('omits every default', () => {
    expect(withoutUndefined(webhookAuditLogsViewToSearch(DEFAULT_WEBHOOK_AUDIT_LOGS_VIEW))).toEqual({});
  });

  it('round-trips a full view', () => {
    const view: WebhookAuditLogsView = {
      datePreset: '24h',
      repository: 'acme/widgets',
      event: 'issue_comment',
      status: WebhookAuditStatus.Processing,
      sourceType: 'user',
    };
    const search = webhookAuditLogsViewToSearch(view);

    expect(search).toEqual({
      webhookRange: '24h',
      webhookRepo: 'acme/widgets',
      webhookEvent: 'issue_comment',
      webhookStatus: WebhookAuditStatus.Processing,
      webhookSource: 'user',
    });
    expect(webhookAuditLogsViewFromSearch(search)).toEqual(view);
  });
});
