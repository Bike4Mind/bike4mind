import { describe, expect, it, beforeAll } from 'vitest';
import { configureSecretsAtRest, generateEncryptionKey, isEncrypted } from '@bike4mind/utils/security';
import { setupMongoTest } from '../../../__test__/utils';
import { SlackDevWorkspace, slackDevWorkspaceRepository } from './SlackDevWorkspaceModel';

describe('Slack app credential encryption', () => {
  setupMongoTest();
  beforeAll(() => {
    configureSecretsAtRest(generateEncryptionKey());
  });

  it('encrypts every OAuth credential on updates while direct and repository reads stay usable', async () => {
    const row = await slackDevWorkspaceRepository.createOrUpdateWithCredentials({
      slackAppId: 'app-test',
      slackClientId: 'client-test',
      slackClientSecret: 'client-secret-canary',
      slackOAuthSigningSecret: 'signing-secret-canary',
      slackVerificationToken: 'verification-canary',
      slackOAuthRedirectUri: 'https://example.com/oauth',
    });
    await slackDevWorkspaceRepository.storeConfigToken(row.id, 'config-token-canary');
    const raw = await SlackDevWorkspace.collection.findOne({ slackAppId: 'app-test' });
    for (const field of [
      'slackClientSecret',
      'slackOAuthSigningSecret',
      'slackVerificationToken',
      'appConfigurationToken',
    ] as const) {
      expect(isEncrypted(raw![field]!)).toBe(true);
    }
    const direct = await SlackDevWorkspace.findById(row.id).select('+slackOAuthSigningSecret');
    expect(direct?.slackOAuthSigningSecret).toBe('signing-secret-canary');
    expect((await slackDevWorkspaceRepository.findByIdWithCredentials(row.id))?.slackClientSecret).toBe(
      'client-secret-canary'
    );
    expect((await slackDevWorkspaceRepository.findByIdWithConfigToken(row.id))?.appConfigurationToken).toBe(
      'config-token-canary'
    );
  });
});
