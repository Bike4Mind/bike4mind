import { describe, it, expect, beforeAll } from 'vitest';
import { configureSecretsAtRest, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { setupMongoTest } from '../../__test__/utils';
import { IdentityProviderModel, identityProviderRepository } from './IdentityProviderModel';

const KEY = generateEncryptionKey();

const samlIdp = (emailDomain: string) => ({
  name: 'Acme SAML',
  emailDomain,
  type: 'saml' as const,
  createdBy: 'admin-1',
  samlConfig: {
    entryPoint: 'https://idp.example/sso',
    issuer: 'https://idp.example/metadata',
    cert: 'PUBLIC-IDP-CERT',
    decryptionPvk: 'SP-DECRYPTION-KEY',
    privateCert: 'SP-SIGNING-KEY',
  },
});

const oktaIdp = (emailDomain: string) => ({
  name: 'Acme Okta',
  emailDomain,
  type: 'okta' as const,
  createdBy: 'admin-1',
  oktaConfig: { audience: 'https://acme.okta.com', clientId: 'client-1', clientSecret: 'OKTA-CLIENT-SECRET' },
});

describe('IdentityProviderRepository secrets at rest', () => {
  setupMongoTest();

  beforeAll(() => {
    configureSecretsAtRest(KEY);
  });

  it('stores SAML key material as ciphertext and keeps the public cert readable', async () => {
    const created = await identityProviderRepository.createIDP(samlIdp('saml.example'));

    const raw = await IdentityProviderModel.findById(created.id)
      .select('+samlConfig.decryptionPvk +samlConfig.privateCert')
      .lean();
    expect(isEncrypted(raw?.samlConfig?.decryptionPvk as string)).toBe(true);
    expect(isEncrypted(raw?.samlConfig?.privateCert as string)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('SP-DECRYPTION-KEY');
    expect(JSON.stringify(raw)).not.toContain('SP-SIGNING-KEY');
    // The IdP's signing certificate is public metadata, not a credential.
    expect(raw?.samlConfig?.cert).toBe('PUBLIC-IDP-CERT');
  });

  it('stores the Okta client secret as ciphertext', async () => {
    const created = await identityProviderRepository.createIDP(oktaIdp('okta.example'));

    const raw = await IdentityProviderModel.findById(created.id).select('+oktaConfig.clientSecret').lean();
    expect(isEncrypted(raw?.oktaConfig?.clientSecret as string)).toBe(true);
  });

  it('hands the login path usable plaintext back', async () => {
    const created = await identityProviderRepository.createIDP(samlIdp('login.example'));

    const forLogin = await identityProviderRepository.findByIdWithSecrets(created.id);
    expect(forLogin?.samlConfig?.decryptionPvk).toBe('SP-DECRYPTION-KEY');
    expect(forLogin?.samlConfig?.privateCert).toBe('SP-SIGNING-KEY');
  });

  it('never carries secrets on the reads the admin API serves', async () => {
    await identityProviderRepository.createIDP(samlIdp('admin.example'));
    await identityProviderRepository.createIDP(oktaIdp('admin2.example'));

    const listed = await identityProviderRepository.findAll();
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('SP-DECRYPTION-KEY');
    expect(serialized).not.toContain('SP-SIGNING-KEY');
    expect(serialized).not.toContain('OKTA-CLIENT-SECRET');
    // Not merely absent in plaintext - the ciphertext is not shipped either.
    expect(listed.every(idp => !idp.samlConfig?.decryptionPvk && !idp.oktaConfig?.clientSecret)).toBe(true);
  });

  it('echoes no secrets back from create or update', async () => {
    const created = await identityProviderRepository.createIDP(samlIdp('echo.example'));
    expect(created.samlConfig?.decryptionPvk).toBeUndefined();

    const updated = await identityProviderRepository.updateIDP(created.id, { name: 'Renamed' });
    expect(updated?.samlConfig?.decryptionPvk).toBeUndefined();
  });

  it('carries stored secrets forward when an edit submits the config without them', async () => {
    const created = await identityProviderRepository.createIDP(samlIdp('edit.example'));

    // What the admin UI sends after a round trip: the config it was served, which has
    // no secret fields on it at all.
    await identityProviderRepository.updateIDP(created.id, {
      name: 'Acme SAML (renamed)',
      samlConfig: {
        entryPoint: 'https://idp.example/sso2',
        issuer: 'https://idp.example/metadata',
        cert: 'PUBLIC-IDP-CERT',
      },
    });

    const forLogin = await identityProviderRepository.findByIdWithSecrets(created.id);
    expect(forLogin?.samlConfig?.entryPoint).toBe('https://idp.example/sso2');
    expect(forLogin?.samlConfig?.decryptionPvk).toBe('SP-DECRYPTION-KEY');
    expect(forLogin?.samlConfig?.privateCert).toBe('SP-SIGNING-KEY');
  });

  it('replaces a secret when the caller actually supplies a new one', async () => {
    const created = await identityProviderRepository.createIDP(oktaIdp('rotate.example'));

    await identityProviderRepository.updateIDP(created.id, {
      oktaConfig: { audience: 'https://acme.okta.com', clientId: 'client-1', clientSecret: 'ROTATED-SECRET' },
    });

    const forLogin = await identityProviderRepository.findByIdWithSecrets(created.id);
    expect(forLogin?.oktaConfig?.clientSecret).toBe('ROTATED-SECRET');
  });

  it('preserves the stored secret when the configured key cannot read it', async () => {
    const created = await identityProviderRepository.createIDP(oktaIdp('badkey.example'));
    const before = await IdentityProviderModel.findById(created.id).select('+oktaConfig.clientSecret').lean();
    const storedCiphertext = before?.oktaConfig?.clientSecret as string;

    // A rotation that lost the old key: the ciphertext is still on disk and still
    // recoverable, but nothing configured can decrypt it right now.
    configureSecretsAtRest(generateEncryptionKey());
    try {
      // The ordinary admin edit - rename only, secret field left blank as the UI instructs.
      await identityProviderRepository.updateIDP(created.id, {
        name: 'Renamed under the wrong key',
        oktaConfig: { audience: 'https://acme.okta.com', clientId: 'client-1' },
      } as never);

      const after = await IdentityProviderModel.findById(created.id).select('+oktaConfig.clientSecret').lean();
      // Carrying the DECRYPTED value forward would have written '' here and destroyed a
      // credential that a restored key would otherwise have recovered.
      expect(after?.oktaConfig?.clientSecret).toBe(storedCiphertext);
      expect(after?.name).toBe('Renamed under the wrong key');
    } finally {
      configureSecretsAtRest(KEY);
    }

    // Proof the credential really is intact: the right key still reads it back.
    const recovered = await identityProviderRepository.findByIdWithSecrets(created.id);
    expect(recovered?.oktaConfig?.clientSecret).toBe('OKTA-CLIENT-SECRET');
  });

  it('reports which secrets are stored without returning any of them', async () => {
    await identityProviderRepository.createIDP(oktaIdp('presence.example'));
    await identityProviderRepository.createIDP({
      name: 'No secret',
      emailDomain: 'blank.example',
      type: 'okta' as const,
      createdBy: 'admin-1',
      oktaConfig: { audience: 'https://blank.okta.com', clientId: 'client-2' },
    } as never);

    const rows = await identityProviderRepository.findAllWithSecretPresence();
    const configured = rows.find(r => r.emailDomain === 'presence.example');
    const blank = rows.find(r => r.emailDomain === 'blank.example');

    expect(configured?.hasSecrets.clientSecret).toBe(true);
    expect(blank?.hasSecrets.clientSecret).toBe(false);
    // The flag is the whole point: no secret value may ride along with it.
    expect(configured?.oktaConfig?.clientSecret).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('OKTA-CLIENT-SECRET');
  });
});
