import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { identityProviderRepository } from './IdentityProviderModel';

const ISSUER = 'https://idp.example/metadata';

const create = (emailDomain: string, overrides: Record<string, unknown> = {}) =>
  identityProviderRepository.createIDP({
    name: emailDomain,
    emailDomain,
    type: 'saml',
    isActive: true,
    createdBy: 'admin-1',
    samlConfig: { entryPoint: 'https://idp.example/sso', issuer: ISSUER, cert: 'PUBLIC-IDP-CERT' },
    ...overrides,
  } as never);

describe('identityProviderRepository.findActiveSamlIdpIdsByIssuer', () => {
  setupMongoTest();

  it('returns every active SAML IdP configured with the issuer, and only those', async () => {
    const a = await create('a.example');
    const b = await create('b.example');
    await create('inactive.example', { isActive: false });
    await create('other.example', {
      samlConfig: { entryPoint: 'https://other/sso', issuer: 'https://other/metadata', cert: 'C' },
    });
    await create('okta.example', {
      type: 'okta',
      samlConfig: undefined,
      oktaConfig: { audience: 'https://okta.example', clientId: 'c', issuer: ISSUER },
    });

    const ids = await identityProviderRepository.findActiveSamlIdpIdsByIssuer(ISSUER);

    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it('returns nothing for an issuer no IdP is configured with', async () => {
    await create('a.example');
    expect(await identityProviderRepository.findActiveSamlIdpIdsByIssuer('https://unknown/metadata')).toEqual([]);
  });
});
