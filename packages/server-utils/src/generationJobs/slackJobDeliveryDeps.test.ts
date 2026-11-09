import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findByIdWithCredentials: vi.fn(),
  decryptToken: vi.fn(),
  initializeSlackPackage: vi.fn(),
  SlackClient: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  slackDevWorkspaceRepository: { findByIdWithCredentials: h.findByIdWithCredentials },
}));
vi.mock('../generations/signOutputUrl', () => ({
  downloadServeableOutput: vi.fn(),
  signOutputUrl: vi.fn(),
}));
vi.mock('../security/tokenEncryption', () => ({ decryptToken: h.decryptToken }));
vi.mock('../integrations/slack/slackPackageInit', () => ({ initializeSlackPackage: h.initializeSlackPackage }));
vi.mock('@bike4mind/slack', () => ({ SlackClient: h.SlackClient }));
vi.mock('@bike4mind/server-utils/files/fileLinkToken', () => ({
  buildFileLinkUrl: (target: unknown, userId: string, ttl: number) => JSON.stringify({ target, userId, ttl }),
}));

import { createSlackJobDeliveryDeps } from './slackJobDeliveryDeps';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
const deps = () => createSlackJobDeliveryDeps(logger as never);

describe('createSlackJobDeliveryDeps getSlackClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findByIdWithCredentials.mockResolvedValue({ slackBotToken: 'encrypted' });
    h.decryptToken.mockReturnValue('xoxb-decrypted');
  });

  it('builds a Slack client from the decrypted bot token and initializes the Slack package first', async () => {
    const client = await deps().getSlackClient('w1');
    expect(h.initializeSlackPackage).toHaveBeenCalledTimes(1);
    expect(h.SlackClient).toHaveBeenCalledWith('xoxb-decrypted', logger);
    expect(client).toBeInstanceOf(h.SlackClient);
  });

  it('returns null when the workspace is missing or has no bot token', async () => {
    h.findByIdWithCredentials.mockResolvedValueOnce(null);
    await expect(deps().getSlackClient('w1')).resolves.toBeNull();
    h.findByIdWithCredentials.mockResolvedValueOnce({ slackBotToken: undefined });
    await expect(deps().getSlackClient('w1')).resolves.toBeNull();
    expect(h.SlackClient).not.toHaveBeenCalled();
  });

  it('returns null when the token decrypts to nothing', async () => {
    h.decryptToken.mockReturnValue(null);
    await expect(deps().getSlackClient('w1')).resolves.toBeNull();
    expect(h.SlackClient).not.toHaveBeenCalled();
  });

  it('returns null and logs when decryptToken throws on a wrong or rotated key', async () => {
    h.decryptToken.mockImplementation(() => {
      throw new Error('Token decryption failed');
    });
    await expect(deps().getSlackClient('w1')).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      'slack bot token could not be decrypted; skipping video delivery',
      expect.objectContaining({ workspaceId: 'w1' })
    );
    expect(h.initializeSlackPackage).not.toHaveBeenCalled();
    expect(h.SlackClient).not.toHaveBeenCalled();
  });
});

describe('createSlackJobDeliveryDeps buildOutputLink', () => {
  const common = { s3Key: 'k.mp4', contentType: 'video/mp4', bytes: 1, durationSeconds: 1 };

  it('links a Files output by its FabFile and a generated output by its key', () => {
    const link = (output: Parameters<ReturnType<typeof deps>['buildOutputLink']>[0]) =>
      deps().buildOutputLink(output, 'u1', 60);
    expect(JSON.parse(link({ ...common, location: 'files', fileId: 'f1' })!)).toEqual({
      target: { kind: 'fabFile', fileId: 'f1' },
      userId: 'u1',
      ttl: 60,
    });
    expect(JSON.parse(link({ ...common, location: 'generated' })!)).toEqual({
      target: { kind: 'generatedKey', key: 'k.mp4' },
      userId: 'u1',
      ttl: 60,
    });
    expect(link({ ...common, location: 'files' })).toBeNull();
  });
});
