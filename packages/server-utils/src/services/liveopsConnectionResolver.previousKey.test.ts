import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { encryptSecret, generateEncryptionKey } from '../security/secretEncryption';

const h = vi.hoisted(() => ({
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findJiraConnection: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  orgSlackWorkspaceRepository: {},
  slackDevWorkspaceRepository: {},
  orgJiraConnectionRepository: { findByOrganizationIdWithCredentials: h.findJiraConnection },
}));
vi.mock('../utils/config', () => ({ Config: h.config }));

import { resolveJiraConfig } from './liveopsConnectionResolver';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const accessTokenFixture = 'jira-access-token-fixture';

describe('resolveJiraConfig with an access token stored under the previous encryption key', () => {
  let previousKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
  });

  it('returns a config carrying the decrypted access token', async () => {
    h.findJiraConnection.mockResolvedValue({
      accessToken: encryptSecret(accessTokenFixture, previousKey),
      cloudId: 'cloud-a',
      siteUrl: 'https://org-a.atlassian.net',
    });

    const config = await resolveJiraConfig('org-a', logger);

    expect(config.accessToken).toBe(accessTokenFixture);
    expect(config.apiBaseUrl).toContain('cloud-a');
  });

  it('reports the credentials as undecryptable when they match neither key', async () => {
    h.findJiraConnection.mockResolvedValue({
      accessToken: encryptSecret(accessTokenFixture, generateEncryptionKey()),
      cloudId: 'cloud-a',
      siteUrl: 'https://org-a.atlassian.net',
    });

    await expect(resolveJiraConfig('org-a', logger)).rejects.toThrow('Failed to decrypt Jira credentials');
  });
});
