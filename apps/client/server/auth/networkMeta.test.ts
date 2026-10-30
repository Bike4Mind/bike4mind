import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateOne = vi.fn();
const record = vi.fn();
const alertSignupNetworkBurst = vi.fn();

vi.mock('@bike4mind/database', () => ({
  User: { updateOne: (...args: unknown[]) => updateOne(...args) },
  authEventRepository: { record: (...args: unknown[]) => record(...args) },
}));

vi.mock('./signupNetworkAlerts', () => ({
  alertSignupNetworkBurst: (...args: unknown[]) => alertSignupNetworkBurst(...args),
}));

import { readNetworkMeta, recordLoginEvent, recordSignupNetwork, type NetworkRequest } from './networkMeta';

const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

function reqWith(headers: Record<string, string>): NetworkRequest {
  return { headers: { 'user-agent': 'Mozilla/5.0', ...headers }, socket: {} };
}

const AWS_REQUEST = reqWith({
  'cloudfront-viewer-address': '203.0.113.7:4431',
  'cloudfront-viewer-asn': '16509',
  'cloudfront-viewer-country': 'US',
});

describe('readNetworkMeta', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('flags a hosting-provider ASN as datacenter and names its operator', () => {
    expect(readNetworkMeta(AWS_REQUEST)).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      asn: 16509,
      asnOrg: 'Amazon AWS',
      country: 'US',
      isDatacenter: true,
      ja4: null,
      wafAnonIp: null,
      wafBotSignal: null,
    });
  });

  it('marks a known non-hosting ASN as not datacenter', () => {
    const meta = readNetworkMeta(reqWith({ 'cloudfront-viewer-asn': '7922' }));
    expect(meta).toMatchObject({ asn: 7922, asnOrg: null, isDatacenter: false });
  });

  it('leaves the datacenter flag unknown when no ASN reached the origin', () => {
    const meta = readNetworkMeta({ headers: {}, socket: {} });
    expect(meta).toEqual({
      ip: null,
      userAgent: null,
      asn: null,
      asnOrg: null,
      country: null,
      isDatacenter: null,
      ja4: null,
      wafAnonIp: null,
      wafBotSignal: null,
    });
  });

  it('returns null for wafAnonIp and wafBotSignal when not on a deployed stage', () => {
    // Without ORIGIN_VERIFY_SECRET the deployed flag is false; WAF headers are untrusted.
    const meta = readNetworkMeta(reqWith({ 'x-amzn-waf-x-waf-anon-ip': '1', 'x-amzn-waf-x-waf-bot-signal': '1' }));
    expect(meta.wafAnonIp).toBeNull();
    expect(meta.wafBotSignal).toBeNull();
  });

  it('returns null for wafAnonIp and wafBotSignal on self-host even with headers present', () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    vi.stubEnv('B4M_SELF_HOST', 'true');
    const meta = readNetworkMeta(reqWith({ 'x-amzn-waf-x-waf-anon-ip': '1', 'x-amzn-waf-x-waf-bot-signal': '1' }));
    expect(meta.wafAnonIp).toBeNull();
    expect(meta.wafBotSignal).toBeNull();
  });

  it('returns null for wafAnonIp and wafBotSignal when the attached ACL does not forward labels', () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    const meta = readNetworkMeta(reqWith({}));
    expect(meta.wafAnonIp).toBeNull();
    expect(meta.wafBotSignal).toBeNull();
  });

  it('reads wafAnonIp and wafBotSignal as false when label forwarding is on and the headers are absent', () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    vi.stubEnv('WAF_LABEL_FORWARDING', 'true');
    const meta = readNetworkMeta(reqWith({ 'x-waf-anon-ip': '1', 'x-waf-bot-signal': '1' }));
    expect(meta.wafAnonIp).toBe(false);
    expect(meta.wafBotSignal).toBe(false);
  });

  it('reads wafAnonIp and wafBotSignal as true on a deployed stage when headers are present', () => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    vi.stubEnv('WAF_LABEL_FORWARDING', 'true');
    const meta = readNetworkMeta(reqWith({ 'x-amzn-waf-x-waf-anon-ip': '1', 'x-amzn-waf-x-waf-bot-signal': '1' }));
    expect(meta.wafAnonIp).toBe(true);
    expect(meta.wafBotSignal).toBe(true);
  });

  it('captures only a bounded observation when origin verification is enabled', () => {
    const ja4 = 't13d0101h2_111111111111_222222222222';
    const req = reqWith({ 'cloudfront-viewer-ja4-fingerprint': ja4 });
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    expect(readNetworkMeta(req).ja4).toBe(ja4);
    vi.stubEnv('ORIGIN_VERIFY_SECRET', '');
    expect(readNetworkMeta(req).ja4).toBeNull();
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    vi.stubEnv('B4M_SELF_HOST', 'true');
    expect(readNetworkMeta(req).ja4).toBeNull();
  });

  it.each(['', 'x'.repeat(1000), 't13d0101h2_111111111111_222222222222,spoofed'])('ignores malformed JA4 %s', value => {
    vi.stubEnv('ORIGIN_VERIFY_SECRET', 'synthetic-secret');
    expect(readNetworkMeta(reqWith({ 'cloudfront-viewer-ja4-fingerprint': value })).ja4).toBeNull();
  });
});

describe('recordSignupNetwork', () => {
  beforeEach(() => {
    updateOne.mockReset().mockResolvedValue({});
    record.mockReset().mockResolvedValue(undefined);
    alertSignupNetworkBurst.mockReset().mockResolvedValue(undefined);
    warn.mockClear();
  });

  it('checks for a signup network burst after the signup event is written, so the count includes it', async () => {
    await recordSignupNetwork({ req: AWS_REQUEST, userId: 'u1', method: 'google' });

    expect(alertSignupNetworkBurst).toHaveBeenCalledWith({
      network: expect.objectContaining({ ip: '203.0.113.7', asn: 16509, isDatacenter: true }),
      userId: 'u1',
      method: 'google',
    });
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(alertSignupNetworkBurst.mock.invocationCallOrder[0]);
  });

  it('stamps signupMeta only on a user that has none, and logs a signup event', async () => {
    await recordSignupNetwork({ req: AWS_REQUEST, userId: 'u1', method: 'google' });

    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'u1', signupMeta: null },
      {
        $set: { signupMeta: expect.objectContaining({ asn: 16509, isDatacenter: true, capturedAt: expect.any(Date) }) },
      }
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'signup', method: 'google', ip: '203.0.113.7' })
    );
  });

  it('still logs the signup event when the user write fails, and never throws', async () => {
    updateOne.mockRejectedValueOnce(new Error('db down'));

    await expect(recordSignupNetwork({ req: AWS_REQUEST, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] signup network metadata not recorded', 'db down');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', type: 'signup' }));
  });

  it('never throws when the signup event write fails', async () => {
    record.mockRejectedValueOnce(new Error('db down'));

    await expect(recordSignupNetwork({ req: AWS_REQUEST, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] signup event not recorded', 'db down');
  });
});

describe('recordLoginEvent', () => {
  beforeEach(() => {
    record.mockReset().mockResolvedValue(undefined);
    warn.mockClear();
  });

  it('logs a login event with the request network', async () => {
    await recordLoginEvent({ req: AWS_REQUEST, userId: 'u1', method: 'otc' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', type: 'login', method: 'otc', asn: 16509 })
    );
  });

  it('never throws when the write fails', async () => {
    record.mockRejectedValueOnce(new Error('db down'));
    await expect(recordLoginEvent({ req: AWS_REQUEST, userId: 'u1', method: 'otc' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[auth] login event not recorded', 'db down');
  });
});
