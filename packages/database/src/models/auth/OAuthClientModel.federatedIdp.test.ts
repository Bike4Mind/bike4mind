import { describe, it, expect } from 'vitest';
import { OAuthClientModel } from './OAuthClientModel';

/**
 * Registration-time validation of the federated trust config. Pure schema validation,
 * so no mongo server is needed - validateSync() runs the same validators create() would.
 */
const base = (federatedIdp?: Record<string, unknown>) =>
  new OAuthClientModel({
    clientId: 'b4m_test_client',
    clientSecretHash: 'hash',
    name: 'Test',
    redirectUris: ['https://app.example/cb'],
    ...(federatedIdp ? { federatedIdp } : {}),
  } as never);

const COGNITO_IDP = {
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool',
  audience: 'app-client-id',
  providerName: 'B4M',
};

const B4M_IDP = {
  issuer: 'https://app.example-b4m.test',
  audience: 'b4m_test_client',
  jwksUri: 'https://app.example-b4m.test/api/oauth/jwks',
  subjectSource: 'sub',
};

function errorPaths(doc: ReturnType<typeof base>): string[] {
  return Object.keys(doc.validateSync()?.errors ?? {});
}

describe('OAuthClient federatedIdp validation', () => {
  it('accepts a non-federated client', () => {
    expect(base().validateSync()).toBeUndefined();
  });

  it('accepts an existing-shape Cognito client with no subjectSource (absent means identities)', () => {
    const doc = base(COGNITO_IDP);
    expect(doc.validateSync()).toBeUndefined();
    // absent must stay absent: no Mongoose default may write a value into stored docs
    expect(doc.federatedIdp?.subjectSource).toBeUndefined();
  });

  it('still requires providerName on an identities-source client', () => {
    const { providerName: _omitted, ...withoutProvider } = COGNITO_IDP;
    expect(errorPaths(base(withoutProvider))).toContain('federatedIdp.providerName');
    expect(errorPaths(base({ ...withoutProvider, subjectSource: 'identities' }))).toContain(
      'federatedIdp.providerName'
    );
  });

  it('accepts a sub-source client with an explicit jwksUri and no providerName', () => {
    expect(base(B4M_IDP).validateSync()).toBeUndefined();
  });

  it('rejects a sub-source client registered without an explicit jwksUri', () => {
    const { jwksUri: _omitted, ...withoutJwks } = B4M_IDP;
    expect(errorPaths(base(withoutJwks))).toContain('federatedIdp.jwksUri');
  });

  it('still requires issuer and audience on both shapes', () => {
    expect(errorPaths(base({ subjectSource: 'sub', jwksUri: B4M_IDP.jwksUri }))).toEqual(
      expect.arrayContaining(['federatedIdp.issuer', 'federatedIdp.audience'])
    );
    expect(errorPaths(base({ providerName: 'B4M' }))).toEqual(
      expect.arrayContaining(['federatedIdp.issuer', 'federatedIdp.audience'])
    );
  });

  it('rejects an unknown subjectSource', () => {
    expect(errorPaths(base({ ...B4M_IDP, subjectSource: 'email' }))).toContain('federatedIdp.subjectSource');
  });
});
