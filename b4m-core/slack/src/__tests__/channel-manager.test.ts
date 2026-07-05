import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleChannelCommand } from '../handlers/channel-manager';
import { SlackClient } from '../SlackClient';
import { Logger } from '@bike4mind/observability';

// Mock SlackClient
vi.mock('../SlackClient', () => {
  return {
    SlackClient: vi.fn().mockImplementation(function () {
      return {
        createChannel: vi.fn(),
        inviteToChannel: vi.fn(),
        archiveChannel: vi.fn(),
        renameChannel: vi.fn(),
        setChannelTopic: vi.fn(),
        setChannelPurpose: vi.fn(),
      };
    }),
  };
});

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('Channel Manager Handler', () => {
  let mockSlackClient: any;
  const mockSlackUserId = 'U123456';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSlackClient = new SlackClient('mock-token', Logger as any);
  });

  describe('authorization', () => {
    it('should deny access to non-admin users', async () => {
      const nonAdminUser = { isAdmin: false, slackSettings: { isWorkspaceAdmin: false } };
      const result = await handleChannelCommand(nonAdminUser, mockSlackUserId, 'create test', mockSlackClient);

      expect(result.text).toContain('do not have permission');
      expect(mockSlackClient.createChannel).not.toHaveBeenCalled();
    });

    it('should allow access to B4M admins', async () => {
      const adminUser = { isAdmin: true };
      mockSlackClient.createChannel.mockResolvedValue({ id: 'C123', name: 'test' });

      await handleChannelCommand(adminUser, mockSlackUserId, 'create test', mockSlackClient);
      expect(mockSlackClient.createChannel).toHaveBeenCalled();
    });

    it('should allow access to Slack workspace admins', async () => {
      const slackAdminUser = { isAdmin: false, slackSettings: { isWorkspaceAdmin: true } };
      mockSlackClient.createChannel.mockResolvedValue({ id: 'C123', name: 'test' });

      await handleChannelCommand(slackAdminUser, mockSlackUserId, 'create test', mockSlackClient);
      expect(mockSlackClient.createChannel).toHaveBeenCalled();
    });
  });

  describe('create command', () => {
    it('should create a public channel', async () => {
      mockSlackClient.createChannel.mockResolvedValue({ id: 'C123', name: 'new-channel' });
      mockSlackClient.inviteToChannel.mockResolvedValue(true);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'create new-channel',
        mockSlackClient
      );

      expect(mockSlackClient.createChannel).toHaveBeenCalledWith('new-channel', false);
      expect(mockSlackClient.inviteToChannel).toHaveBeenCalledWith('C123', [mockSlackUserId]);
      expect(result.text).toContain('Created public channel');
    });

    it('should create a private channel', async () => {
      mockSlackClient.createChannel.mockResolvedValue({ id: 'C123', name: 'new-private-channel' });
      mockSlackClient.inviteToChannel.mockResolvedValue(true);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'create new-private-channel private',
        mockSlackClient
      );

      expect(mockSlackClient.createChannel).toHaveBeenCalledWith('new-private-channel', true);
      expect(result.text).toContain('Created private channel');
    });

    it('should validate channel name (invalid chars)', async () => {
      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'create invalid!name',
        mockSlackClient
      );

      expect(mockSlackClient.createChannel).not.toHaveBeenCalled();
      expect(result.text).toContain('Channel names can only contain lowercase letters');
    });

    it('should validate channel name (too long)', async () => {
      const longName = 'a'.repeat(81);
      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        `create ${longName}`,
        mockSlackClient
      );

      expect(mockSlackClient.createChannel).not.toHaveBeenCalled();
      expect(result.text).toContain('Channel name must be 80 characters or less');
    });

    it('should handle name taken error', async () => {
      const error = new Error('Name taken');
      (error as any).data = { error: 'name_taken' };
      mockSlackClient.createChannel.mockRejectedValue(error);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'create taken-name',
        mockSlackClient
      );

      expect(result.text).toContain('Channel name "taken-name" is already taken');
    });
  });

  describe('archive command', () => {
    it('should archive a channel', async () => {
      mockSlackClient.archiveChannel.mockResolvedValue(true);

      const result = await handleChannelCommand({ isAdmin: true }, mockSlackUserId, 'archive C123', mockSlackClient);

      expect(mockSlackClient.archiveChannel).toHaveBeenCalledWith('C123');
      expect(result.text).toContain('has been archived');
    });

    it('should handle missing channel ID', async () => {
      const result = await handleChannelCommand({ isAdmin: true }, mockSlackUserId, 'archive', mockSlackClient);

      expect(mockSlackClient.archiveChannel).not.toHaveBeenCalled();
      expect(result.text).toContain('Please provide a channel ID');
    });
  });

  describe('rename command', () => {
    it('should rename a channel', async () => {
      mockSlackClient.renameChannel.mockResolvedValue(true);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'rename C123 new-name',
        mockSlackClient
      );

      expect(mockSlackClient.renameChannel).toHaveBeenCalledWith('C123', 'new-name');
      expect(result.text).toContain('Channel renamed');
    });
  });

  describe('topic command', () => {
    it('should set channel topic', async () => {
      mockSlackClient.setChannelTopic.mockResolvedValue(true);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'topic C123 New Topic',
        mockSlackClient
      );

      expect(mockSlackClient.setChannelTopic).toHaveBeenCalledWith('C123', 'New Topic');
      expect(result.text).toContain('Topic set');
    });
  });

  describe('purpose command', () => {
    it('should set channel purpose', async () => {
      mockSlackClient.setChannelPurpose.mockResolvedValue(true);

      const result = await handleChannelCommand(
        { isAdmin: true },
        mockSlackUserId,
        'purpose C123 New Purpose',
        mockSlackClient
      );

      expect(mockSlackClient.setChannelPurpose).toHaveBeenCalledWith('C123', 'New Purpose');
      expect(result.text).toContain('Purpose set');
    });
  });
});
