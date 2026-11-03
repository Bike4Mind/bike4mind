import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ config: {} as Record<string, string | undefined> }));
vi.mock('./config', () => ({ Config: h.config }));

import { isPushDeliveryConfigured, readApnsCredentials } from './pushDelivery';

const NAMES = ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_KEY', 'APNS_TOPIC'] as const;

describe('isPushDeliveryConfigured', () => {
  const saved: Partial<Record<(typeof NAMES)[number], string>> = {};

  beforeEach(() => {
    for (const name of NAMES) {
      saved[name] = process.env[name];
      delete process.env[name];
      h.config[name] = 'not-configured';
    }
  });
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("is false on the secrets' 'not-configured' defaults", () => {
    expect(isPushDeliveryConfigured()).toBe(false);
  });

  it('is false when one secret is still on its default', () => {
    Object.assign(h.config, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY: 'pem' });
    expect(isPushDeliveryConfigured()).toBe(false);
  });

  it('is true once all four secrets are set', () => {
    Object.assign(h.config, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY: 'pem', APNS_TOPIC: 'com.example' });
    expect(isPushDeliveryConfigured()).toBe(true);
  });

  it('is false when the secrets are not linked at all (readOptionalSecret yields undefined)', () => {
    for (const name of NAMES) h.config[name] = undefined;
    expect(isPushDeliveryConfigured()).toBe(false);
  });

  it('falls back to plain env, as a self-host worker sets it', () => {
    Object.assign(process.env, { APNS_KEY_ID: 'K', APNS_TEAM_ID: 'T', APNS_KEY: 'pem', APNS_TOPIC: 'com.example' });
    expect(readApnsCredentials()).toEqual({ keyId: 'K', teamId: 'T', key: 'pem', topic: 'com.example' });
  });
});
