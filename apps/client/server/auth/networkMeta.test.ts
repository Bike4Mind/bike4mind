import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateOne = vi.fn();
const record = vi.fn();

vi.mock('@bike4mind/database', () => ({
  User: { updateOne: (...args: unknown[]) => updateOne(...args) },
  authEventRepository: { record: (...args: unknown[]) => record(...args) },
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
    });
  });

  it('marks a known non-hosting ASN as not datacenter', () => {
    const meta = readNetworkMeta(reqWith({ 'cloudfront-viewer-asn': '7922' }));
    expect(meta).toMatchObject({ asn: 7922, asnOrg: null, isDatacenter: false });
  });

  it('leaves the datacenter flag unknown when no ASN reached the origin', () => {
    const meta = readNetworkMeta({ headers: {}, socket: {} });
    expect(meta).toEqual({ ip: null, userAgent: null, asn: null, asnOrg: null, country: null, isDatacenter: null });
  });
});

describe('recordSignupNetwork', () => {
  beforeEach(() => {
    updateOne.mockReset().mockResolvedValue({});
    record.mockReset().mockResolvedValue(undefined);
    warn.mockClear();
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
