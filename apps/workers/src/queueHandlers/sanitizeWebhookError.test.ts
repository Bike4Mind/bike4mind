import { describe, it, expect } from 'vitest';
import { sanitizeDispatchError, sanitizeHandlerError, sanitizeNotificationError } from './sanitizeWebhookError';

describe('sanitizeDispatchError', () => {
  it('preserves the already-safe no-workspace sentinel', () => {
    expect(sanitizeDispatchError('No active Slack workspace with bot token')).toBe(
      'No active Slack workspace with bot token'
    );
  });

  it('collapses Mongo-laden target enumeration errors', () => {
    expect(
      sanitizeDispatchError('Target enumeration failed: connection <mongodb-replica-1.internal:27017> timed out')
    ).toBe('Database temporarily unavailable');
  });

  it('collapses subscription-check errors (the original reproduction)', () => {
    expect(sanitizeDispatchError('Subscription check failed: replica set election in progress')).toBe(
      'Database temporarily unavailable'
    );
  });

  it('collapses subscriber-lookup errors from the handlers', () => {
    expect(sanitizeDispatchError('Subscriber lookup failed: ECONNRESET')).toBe('Database temporarily unavailable');
  });

  it('collapses KMS-bearing bot token errors', () => {
    expect(
      sanitizeDispatchError('Bot token fetch failed: KMSInvalidStateException: arn:aws:kms:us-east-1:123:key/abc')
    ).toBe('Slack workspace credentials unavailable');
  });

  it('collapses DI resolution errors', () => {
    expect(sanitizeDispatchError('DI resolution failed: getSlackDb not registered')).toBe(
      'Internal configuration error'
    );
  });

  it('collapses Notifier-threw errors', () => {
    expect(sanitizeDispatchError('Notifier threw: TypeError: Cannot read properties of undefined')).toBe(
      'Notification dispatch failed'
    );
  });

  it('falls back to a generic label for unrecognized prefixes', () => {
    expect(sanitizeDispatchError('something completely unexpected')).toBe('Notification dispatch failed');
  });
});

describe('sanitizeNotificationError', () => {
  it.each([
    'channel_not_found',
    'not_in_channel',
    'is_archived',
    'account_inactive',
    'user_not_found',
    'token_revoked',
    'invalid_auth',
    'missing_scope',
    'rate_limited',
  ])('passes through known Slack error code: %s', code => {
    expect(sanitizeNotificationError(code)).toBe(`Slack delivery failed: ${code}`);
  });

  it('extracts a known code from a longer message', () => {
    expect(sanitizeNotificationError('Slack sendMessage returned no result; reason: channel_not_found')).toBe(
      'Slack delivery failed: channel_not_found'
    );
  });

  it('collapses unknown error strings', () => {
    expect(sanitizeNotificationError('socket hang up to internal-host.svc.cluster.local:443')).toBe(
      'Slack delivery failed'
    );
  });
});

describe('sanitizeHandlerError', () => {
  it('always returns a generic label since handler errors are arbitrary', () => {
    expect(sanitizeHandlerError('TypeError: foo is not a function at /var/task/index.js:42')).toBe(
      'Handler failed to process event'
    );
    expect(sanitizeHandlerError('boom')).toBe('Handler failed to process event');
  });
});
