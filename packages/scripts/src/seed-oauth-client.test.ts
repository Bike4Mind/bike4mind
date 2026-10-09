import { describe, it, expect, afterEach } from 'vitest';
import { resolveOAuthFederatedIdp } from '@bike4mind/common';
import { readFederatedIdpEnv, resolveClientType } from './seed-oauth-client';

const priorClientType = process.env.CLIENT_TYPE;

afterEach(() => {
  if (priorClientType === undefined) delete process.env.CLIENT_TYPE;
  else process.env.CLIENT_TYPE = priorClientType;
});

describe('resolveClientType', () => {
  it('defaults an unclassified registration to the non-privileged relying-party class', () => {
    delete process.env.CLIENT_TYPE;
    expect(resolveClientType()).toBe('relying-party');
  });

  it('allows an explicit first-party opt-in', () => {
    process.env.CLIENT_TYPE = 'first-party';
    expect(resolveClientType()).toBe('first-party');
  });

  it('rejects an unknown value rather than silently trusting it', () => {
    process.env.CLIENT_TYPE = 'privileged';
    expect(() => resolveClientType()).toThrow(/CLIENT_TYPE/);
  });
});

describe('readFederatedIdpEnv', () => {
  const KEYS = [
    'FEDERATED_ISSUER',
    'FEDERATED_AUDIENCE',
    'FEDERATED_PROVIDER_NAME',
    'FEDERATED_JWKS_URI',
    'FEDERATED_SUBJECT_SOURCE',
  ];
  const prior = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));

  afterEach(() => {
    for (const k of KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  });

  it('returns undefined for a non-federated registration', () => {
    for (const k of KEYS) delete process.env[k];
    expect(readFederatedIdpEnv()).toBeUndefined();
  });

  it('passes the raw values through for the shared resolver to validate', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.FEDERATED_SUBJECT_SOURCE = 'sub';
    process.env.FEDERATED_ISSUER = 'https://b4m.example.test';
    expect(readFederatedIdpEnv()).toEqual({ subjectSource: 'sub', issuer: 'https://b4m.example.test' });
  });

  it('lets FEDERATED_SUBJECT_SOURCE=identities alone reach the resolver, which rejects it', () => {
    for (const k of KEYS) delete process.env[k];
    process.env.FEDERATED_SUBJECT_SOURCE = 'identities';
    const input = readFederatedIdpEnv();
    expect(input).toEqual({ subjectSource: 'identities' });
    expect(() => resolveOAuthFederatedIdp(input, 'cid')).toThrow(/together/);
  });

  it('rejects an unknown subject source', () => {
    process.env.FEDERATED_SUBJECT_SOURCE = 'email';
    expect(() => readFederatedIdpEnv()).toThrow(/FEDERATED_SUBJECT_SOURCE/);
  });
});
