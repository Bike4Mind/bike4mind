import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FabFileSourceType } from '@bike4mind/common';

const {
  findByDatalakeTags,
  findByOrganizationIdWithToken,
  findBySlackTeamIdWithTokenOrg,
  findBySlackAppIdAndTeamId,
  findByIdWithCredentials,
  decryptToken,
  sendMessage,
} = vi.hoisted(() => ({
  findByDatalakeTags: vi.fn(),
  findByOrganizationIdWithToken: vi.fn(),
  findBySlackTeamIdWithTokenOrg: vi.fn(),
  findBySlackAppIdAndTeamId: vi.fn(),
  findByIdWithCredentials: vi.fn(),
  decryptToken: vi.fn(),
  sendMessage: vi.fn(async () => undefined),
}));

vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findByDatalakeTags },
  slackDevWorkspaceRepository: { findBySlackAppIdAndTeamId, findByIdWithCredentials },
}));
vi.mock('@bike4mind/database/infra', () => ({
  orgSlackWorkspaceRepository: {
    findByOrganizationIdWithToken,
    findBySlackTeamIdWithToken: findBySlackTeamIdWithTokenOrg,
  },
}));
vi.mock('@server/security/tokenEncryption', () => ({ decryptToken }));
// Ctor args recorded (not discarded) so a regression sending the wrong/encrypted token is caught.
vi.mock('@bike4mind/slack', async importOriginal => {
  // escapeSlackMrkdwn imported from the REAL module, not reimplemented: these tests assert on
  // exact message text pinned to what it neutralizes (e.g. "<!channel>"), and a hand-copy would
  // silently stop matching if the real implementation ever gains a new escaped character.
  const actual = await importOriginal<typeof import('@bike4mind/slack')>();
  return {
    SlackClient: class {
      constructor(
        public botToken: string,
        public logger: unknown,
        public options?: { timeoutMs?: number }
      ) {}
      sendMessage = sendMessage;
    },
    escapeSlackMrkdwn: actual.escapeSlackMrkdwn,
  };
});

import { notifySlackIndexingComplete } from './notifySlackIndexingComplete';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const slackFabFile = (overrides: Record<string, unknown> = {}) => ({
  id: 'fab-1',
  fileName: 'Report.pdf',
  sourceType: FabFileSourceType.SLACK,
  sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001', teamId: 'T123', apiAppId: 'A123' },
  tags: [{ name: 'datalake:sales', strength: 1 }],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  findBySlackAppIdAndTeamId.mockResolvedValue(null);
  findByIdWithCredentials.mockResolvedValue(null);
  findBySlackTeamIdWithTokenOrg.mockResolvedValue({ slackBotToken: 'encrypted-org-token' });
  findByDatalakeTags.mockResolvedValue([{ id: 'lake-1', name: 'Sales Lake', organizationId: 'org-1' }]);
  findByOrganizationIdWithToken.mockResolvedValue({ slackBotToken: 'encrypted-token' });
  decryptToken.mockImplementation((value: string) => (value ? `decrypted:${value}` : null));
});

describe('notifySlackIndexingComplete (#2027)', () => {
  it('resolves the bot token via the dev-OAuth workspace for the message (apiAppId, teamId) pair, and posts a threaded reply naming the file and lake', async () => {
    // Mirrors events.ts's own inbound resolution: the pair-keyed lookup finds the workspace, a
    // second call by id fetches its credentials - the pair-keyed lookup does not select the token.
    findBySlackAppIdAndTeamId.mockResolvedValue({ id: 'dev-ws-1' });
    findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'encrypted-dev-token' });

    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(findBySlackAppIdAndTeamId).toHaveBeenCalledWith('A123', 'T123');
    expect(findByIdWithCredentials).toHaveBeenCalledWith('dev-ws-1');
    expect(findBySlackTeamIdWithTokenOrg).not.toHaveBeenCalled();
    // #2029: the lake lookup happens on this path too (not just the legacy fallback), so the
    // message can name the lake - but only reached because the token above already resolved.
    expect(findByDatalakeTags).toHaveBeenCalledWith(['datalake:sales']);
    expect(decryptToken).toHaveBeenCalledWith('encrypted-dev-token');
    expect(sendMessage).toHaveBeenCalledWith({
      channel: 'C123',
      threadTs: '1700000000.0001',
      text: '"Report.pdf" finished indexing in *Sales Lake* and is now searchable.',
    });
    // The DECRYPTED token reaches the SlackClient constructor, never the encrypted one.
    const client = sendMessage.mock.instances[0] as unknown as { botToken: string };
    expect(client.botToken).toBe('decrypted:encrypted-dev-token');
  });

  it('falls back to the org workspace for the message teamId when no dev-OAuth workspace matches the (apiAppId, teamId) pair', async () => {
    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(findBySlackAppIdAndTeamId).toHaveBeenCalledWith('A123', 'T123');
    expect(findByIdWithCredentials).not.toHaveBeenCalled();
    expect(findBySlackTeamIdWithTokenOrg).toHaveBeenCalledWith('T123');
    expect(findByDatalakeTags).toHaveBeenCalledWith(['datalake:sales']);
    expect(decryptToken).toHaveBeenCalledWith('encrypted-org-token');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('*Sales Lake*') })
    );
  });

  it('degrades to file-only wording when the teamId path resolves a token but no lake matches', async () => {
    findBySlackAppIdAndTeamId.mockResolvedValue({ id: 'dev-ws-1' });
    findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'encrypted-dev-token' });
    findByDatalakeTags.mockResolvedValue([]);

    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '"Report.pdf" finished indexing and is now searchable.' })
    );
  });

  it('escapes the lake name too, not just the file name, so a malicious lake name cannot broadcast', async () => {
    findBySlackAppIdAndTeamId.mockResolvedValue({ id: 'dev-ws-1' });
    findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'encrypted-dev-token' });
    findByDatalakeTags.mockResolvedValue([{ id: 'lake-1', name: '<!channel>', organizationId: 'org-1' }]);

    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '"Report.pdf" finished indexing in *&lt;!channel&gt;* and is now searchable.',
      })
    );
  });

  it('skips when teamId resolves to no workspace at all, without falling back to the lake/org chain', async () => {
    findBySlackTeamIdWithTokenOrg.mockResolvedValue(null);

    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(findByDatalakeTags).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    // A stamped-but-unresolvable teamId is a real data-health signal (uninstalled workspace,
    // rotated token), unlike the deliberate no-teamId skip below - so it gets its own warn too.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('T123'));
  });

  it('semi-legacy: skips the dev-workspace lookup entirely when teamId is stamped but apiAppId is not, falling straight to the org lookup', async () => {
    // A file ingested between the teamId-only stamp and the apiAppId addition. Resolving the
    // dev-workspace via teamId alone was the exact bug this pair-keyed lookup fixes - skip it
    // rather than risk resolving an arbitrary install's token.
    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001', teamId: 'T123' } }),
      logger
    );

    expect(findBySlackAppIdAndTeamId).not.toHaveBeenCalled();
    expect(findByIdWithCredentials).not.toHaveBeenCalled();
    expect(findBySlackTeamIdWithTokenOrg).toHaveBeenCalledWith('T123');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('apiAppId'));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('*Sales Lake*') })
    );
  });

  it('falls back to the tags->lake->org chain, with a warning, when sourceMetadata has no teamId (pre-stamp files)', async () => {
    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(findBySlackAppIdAndTeamId).not.toHaveBeenCalled();
    expect(findBySlackTeamIdWithTokenOrg).not.toHaveBeenCalled();
    expect(findByDatalakeTags).toHaveBeenCalledWith(['datalake:sales']);
    expect(findByOrganizationIdWithToken).toHaveBeenCalledWith('org-1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('teamId'));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('*Sales Lake*') })
    );
  });

  it('skips non-Slack-origin files without touching any repository', async () => {
    await notifySlackIndexingComplete(slackFabFile({ sourceType: undefined }), logger);

    expect(findBySlackAppIdAndTeamId).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('skips when sourceMetadata is missing channel/messageTs', async () => {
    await notifySlackIndexingComplete(slackFabFile({ sourceMetadata: { teamId: 'T123' } }), logger);

    expect(findBySlackAppIdAndTeamId).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: skips when the file carries no lake tag at all', async () => {
    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' }, tags: [] }),
      logger
    );

    expect(findByDatalakeTags).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: skips when no lake matches the tags (findByDatalakeTags returns empty)', async () => {
    findByDatalakeTags.mockResolvedValue([]);

    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(findByOrganizationIdWithToken).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: skips an org-less (personal) lake rather than throwing', async () => {
    findByDatalakeTags.mockResolvedValue([{ id: 'lake-1', organizationId: undefined }]);

    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(findByOrganizationIdWithToken).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: skips when the org has no Slack workspace on file', async () => {
    findByOrganizationIdWithToken.mockResolvedValue(null);

    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: skips when the workspace has no bot token to decrypt', async () => {
    findByOrganizationIdWithToken.mockResolvedValue({ slackBotToken: null });

    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(decryptToken).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('legacy fallback: uses the first matching lake and logs a warning when a file matches more than one', async () => {
    findByDatalakeTags.mockResolvedValue([
      { id: 'lake-1', name: 'Lake One', organizationId: 'org-1' },
      { id: 'lake-2', name: 'Lake Two', organizationId: 'org-2' },
    ]);

    await notifySlackIndexingComplete(
      slackFabFile({ sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001' } }),
      logger
    );

    expect(findByOrganizationIdWithToken).toHaveBeenCalledWith('org-1');
    expect(logger.warn).toHaveBeenCalled();
    // The ambiguity is a warning, not a refusal - the reply still goes out for the first match.
    expect(sendMessage).toHaveBeenCalled();
  });

  it('teamId path: uses the first matching lake and logs a warning when a file matches more than one (resolveLake is shared with the legacy path)', async () => {
    findBySlackAppIdAndTeamId.mockResolvedValue({ id: 'dev-ws-1' });
    findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'encrypted-dev-token' });
    findByDatalakeTags.mockResolvedValue([
      { id: 'lake-1', name: 'Sales Lake', organizationId: 'org-1' },
      { id: 'lake-2', name: 'Support Lake', organizationId: 'org-2' },
    ]);

    await notifySlackIndexingComplete(slackFabFile(), logger);

    expect(logger.warn).toHaveBeenCalled();
    // Same ambiguity handling as the legacy path: warn, but still name the first match.
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('*Sales Lake*') })
    );
  });
});
