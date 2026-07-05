import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { questExternalLinkRepository, QuestExternalLink } from '../QuestExternalLinkModel';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from '../../../__test__/createMongoServer';

describe('QuestExternalLinkModel', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);

    await QuestExternalLink.createIndexes();
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const createBasicLink = (overrides = {}) => ({
    questPlanId: 'quest-plan-123',
    userId: 'user-456',
    capabilityType: 'github' as const,
    externalId: 'owner/repo#1',
    externalUrl: 'https://github.com/owner/repo/issues/1',
    syncDirection: 'bidirectional' as const,
    status: 'pending' as const,
    github: {
      repository: 'owner/repo',
      issueNumber: 1,
    },
    createdBy: 'user-456',
    ...overrides,
  });

  describe('create link', () => {
    it('should create a link with required fields', async () => {
      const linkData = createBasicLink();

      const link = await questExternalLinkRepository.create(linkData);

      expect(link.questPlanId).toBe('quest-plan-123');
      expect(link.userId).toBe('user-456');
      expect(link.capabilityType).toBe('github');
      expect(link.externalId).toBe('owner/repo#1');
      expect(link.externalUrl).toBe('https://github.com/owner/repo/issues/1');
      expect(link.syncDirection).toBe('bidirectional');
      expect(link.status).toBe('pending');
      expect(link.github?.repository).toBe('owner/repo');
      expect(link.github?.issueNumber).toBe(1);
      expect(link.createdAt).toBeDefined();
      expect(link.updatedAt).toBeDefined();
    });

    it('should create a link with organizationId', async () => {
      const linkData = createBasicLink({ organizationId: 'org-789' });

      const link = await questExternalLinkRepository.create(linkData);

      expect(link.organizationId).toBe('org-789');
    });

    it('should create a link with questId for sub-quest', async () => {
      const linkData = createBasicLink({ questId: 'sub-quest-001' });

      const link = await questExternalLinkRepository.create(linkData);

      expect(link.questId).toBe('sub-quest-001');
    });

    it('should default syncDirection to bidirectional', async () => {
      const linkData = createBasicLink();
      delete (linkData as Record<string, unknown>).syncDirection;

      const link = await questExternalLinkRepository.create(linkData);

      expect(link.syncDirection).toBe('bidirectional');
    });

    it('should default status to pending', async () => {
      const linkData = createBasicLink();
      delete (linkData as Record<string, unknown>).status;

      const link = await questExternalLinkRepository.create(linkData);

      expect(link.status).toBe('pending');
    });
  });

  describe('unique constraint', () => {
    it('should prevent duplicate links for same quest+capability+externalId', async () => {
      const linkData = createBasicLink();

      await questExternalLinkRepository.create(linkData);

      await expect(questExternalLinkRepository.create(linkData)).rejects.toThrow(/duplicate key/i);
    });

    it('should allow same externalId with different questPlanId', async () => {
      const linkData1 = createBasicLink({ questPlanId: 'quest-plan-1' });
      const linkData2 = createBasicLink({ questPlanId: 'quest-plan-2' });

      const link1 = await questExternalLinkRepository.create(linkData1);
      const link2 = await questExternalLinkRepository.create(linkData2);

      expect(link1.questPlanId).toBe('quest-plan-1');
      expect(link2.questPlanId).toBe('quest-plan-2');
    });

    it('should allow same questPlanId with different capabilityType', async () => {
      const githubLink = createBasicLink({ capabilityType: 'github', externalId: 'github-123' });
      const slackLink = createBasicLink({
        capabilityType: 'slack',
        externalId: 'slack-456',
        slack: { channelId: 'C123' },
        github: undefined,
      });

      const link1 = await questExternalLinkRepository.create(githubLink);
      const link2 = await questExternalLinkRepository.create(slackLink);

      expect(link1.capabilityType).toBe('github');
      expect(link2.capabilityType).toBe('slack');
    });

    it('should allow multiple links from same plan to different external resources (no questId)', async () => {
      // Real use case: Link a plan to multiple GitHub issues (e.g., different repos or tracking issues)
      const link1 = await questExternalLinkRepository.create(
        createBasicLink({
          questPlanId: 'plan-1',
          questId: undefined, // No sub-quest, linking whole plan
          externalId: 'owner/repo-a#1',
          github: { repository: 'owner/repo-a', issueNumber: 1 },
        })
      );

      const link2 = await questExternalLinkRepository.create(
        createBasicLink({
          questPlanId: 'plan-1',
          questId: undefined, // Same - no sub-quest
          externalId: 'owner/repo-b#2',
          github: { repository: 'owner/repo-b', issueNumber: 2 },
        })
      );

      expect(link1.questPlanId).toBe('plan-1');
      expect(link2.questPlanId).toBe('plan-1');
      expect(link1.externalId).toBe('owner/repo-a#1');
      expect(link2.externalId).toBe('owner/repo-b#2');

      const allLinks = await questExternalLinkRepository.findByQuestPlanId('plan-1', 'user-456');
      expect(allLinks).toHaveLength(2);
    });
  });

  describe('findByQuestPlanId', () => {
    it('should find all links for a quest plan with matching userId', async () => {
      await questExternalLinkRepository.create(createBasicLink({ questPlanId: 'quest-plan-1', externalId: 'ext-1' }));
      await questExternalLinkRepository.create(createBasicLink({ questPlanId: 'quest-plan-1', externalId: 'ext-2' }));

      await questExternalLinkRepository.create(createBasicLink({ questPlanId: 'quest-plan-2', externalId: 'ext-3' }));

      const links = await questExternalLinkRepository.findByQuestPlanId('quest-plan-1', 'user-456');

      expect(links).toHaveLength(2);
      expect(links.every(l => l.questPlanId === 'quest-plan-1')).toBe(true);
    });

    it('should return empty array for non-existent quest plan', async () => {
      const links = await questExternalLinkRepository.findByQuestPlanId('non-existent', 'user-456');

      expect(links).toHaveLength(0);
    });

    it('should not return links belonging to other users (IDOR protection)', async () => {
      await questExternalLinkRepository.create(createBasicLink({ questPlanId: 'quest-plan-1', externalId: 'ext-1' }));

      const links = await questExternalLinkRepository.findByQuestPlanId('quest-plan-1', 'attacker-user');

      expect(links).toHaveLength(0);
    });
  });

  describe('findByQuestId', () => {
    it('should find links for a specific sub-quest with matching userId', async () => {
      await questExternalLinkRepository.create(
        createBasicLink({ questPlanId: 'plan-1', questId: 'quest-a', externalId: 'ext-1' })
      );
      await questExternalLinkRepository.create(
        createBasicLink({ questPlanId: 'plan-1', questId: 'quest-b', externalId: 'ext-2' })
      );

      const links = await questExternalLinkRepository.findByQuestId('plan-1', 'quest-a', 'user-456');

      expect(links).toHaveLength(1);
      expect(links[0].questId).toBe('quest-a');
    });

    it('should not return links belonging to other users (IDOR protection)', async () => {
      await questExternalLinkRepository.create(
        createBasicLink({ questPlanId: 'plan-1', questId: 'quest-a', externalId: 'ext-1' })
      );

      const links = await questExternalLinkRepository.findByQuestId('plan-1', 'quest-a', 'attacker-user');

      expect(links).toHaveLength(0);
    });
  });

  describe('findByExternalId', () => {
    it('should find link by capability type and external ID with matching userId', async () => {
      await questExternalLinkRepository.create(createBasicLink({ externalId: 'unique-ext-id' }));

      const link = await questExternalLinkRepository.findByExternalId('github', 'unique-ext-id', 'user-456');

      expect(link).toBeDefined();
      expect(link?.externalId).toBe('unique-ext-id');
    });

    it('should return null/undefined for non-matching capability type', async () => {
      await questExternalLinkRepository.create(createBasicLink({ externalId: 'github-only' }));

      const link = await questExternalLinkRepository.findByExternalId('slack', 'github-only', 'user-456');

      expect(link).toBeFalsy();
    });

    it('should not return links belonging to other users (IDOR protection)', async () => {
      await questExternalLinkRepository.create(createBasicLink({ externalId: 'unique-ext-id' }));

      const link = await questExternalLinkRepository.findByExternalId('github', 'unique-ext-id', 'attacker-user');

      expect(link).toBeFalsy();
    });
  });

  describe('findByGitHubIssue', () => {
    it('should find link by repository and issue number with matching userId', async () => {
      await questExternalLinkRepository.create(
        createBasicLink({
          github: { repository: 'owner/repo', issueNumber: 42 },
          externalId: 'owner/repo#42',
        })
      );

      const link = await questExternalLinkRepository.findByGitHubIssue('owner/repo', 42, 'user-456');

      expect(link).toBeDefined();
      expect(link?.github?.repository).toBe('owner/repo');
      expect(link?.github?.issueNumber).toBe(42);
    });

    it('should return null/undefined for non-existent issue', async () => {
      const link = await questExternalLinkRepository.findByGitHubIssue('owner/repo', 999, 'user-456');

      expect(link).toBeFalsy();
    });

    it('should not return links belonging to other users (IDOR protection)', async () => {
      await questExternalLinkRepository.create(
        createBasicLink({
          github: { repository: 'owner/repo', issueNumber: 42 },
          externalId: 'owner/repo#42',
        })
      );

      const link = await questExternalLinkRepository.findByGitHubIssue('owner/repo', 42, 'attacker-user');

      expect(link).toBeFalsy();
    });
  });

  describe('findPendingSync', () => {
    it('should find links with pending status', async () => {
      await questExternalLinkRepository.create(createBasicLink({ status: 'pending', externalId: 'ext-1' }));
      await questExternalLinkRepository.create(createBasicLink({ status: 'synced', externalId: 'ext-2' }));
      await questExternalLinkRepository.create(createBasicLink({ status: 'pending', externalId: 'ext-3' }));

      const pendingLinks = await questExternalLinkRepository.findPendingSync();

      expect(pendingLinks).toHaveLength(2);
      expect(pendingLinks.every(l => l.status === 'pending')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      await questExternalLinkRepository.create(createBasicLink({ status: 'pending', externalId: 'ext-1' }));
      await questExternalLinkRepository.create(createBasicLink({ status: 'pending', externalId: 'ext-2' }));
      await questExternalLinkRepository.create(createBasicLink({ status: 'pending', externalId: 'ext-3' }));

      const pendingLinks = await questExternalLinkRepository.findPendingSync(2);

      expect(pendingLinks).toHaveLength(2);
    });
  });

  describe('findWithErrors', () => {
    it('should find links with error status under retry limit', async () => {
      // Link with error, retryCount = 1
      await questExternalLinkRepository.create(
        createBasicLink({
          status: 'error',
          externalId: 'ext-1',
          lastError: { message: 'API error', timestamp: new Date(), retryCount: 1 },
        })
      );

      // Link with error, retryCount = 5 (over limit)
      await questExternalLinkRepository.create(
        createBasicLink({
          status: 'error',
          externalId: 'ext-2',
          lastError: { message: 'API error', timestamp: new Date(), retryCount: 5 },
        })
      );

      // Link without error
      await questExternalLinkRepository.create(createBasicLink({ status: 'synced', externalId: 'ext-3' }));

      const errorLinks = await questExternalLinkRepository.findWithErrors(3);

      expect(errorLinks).toHaveLength(1);
      expect(errorLinks[0].lastError?.retryCount).toBe(1);
    });
  });

  describe('updateSyncStatus', () => {
    it('should update status and versions', async () => {
      const link = await questExternalLinkRepository.create(createBasicLink());

      const updated = await questExternalLinkRepository.updateSyncStatus(link.id, 'synced', {
        localVersion: 'v1',
        remoteVersion: 'v2',
      });

      expect(updated?.status).toBe('synced');
      expect(updated?.localVersion).toBe('v1');
      expect(updated?.remoteVersion).toBe('v2');
      expect(updated?.lastSyncedAt).toBeDefined();
    });

    it('should set lastSyncedAt only when status is synced', async () => {
      const link = await questExternalLinkRepository.create(createBasicLink());

      const updated = await questExternalLinkRepository.updateSyncStatus(link.id, 'error');

      expect(updated?.status).toBe('error');
      expect(updated?.lastSyncedAt).toBeUndefined();
    });
  });

  describe('recordError', () => {
    it('should record error and increment retry count', async () => {
      const link = await questExternalLinkRepository.create(createBasicLink());

      const updated = await questExternalLinkRepository.recordError(link.id, {
        message: 'Network timeout',
        code: 'ETIMEDOUT',
      });

      expect(updated?.status).toBe('error');
      expect(updated?.lastError?.message).toBe('Network timeout');
      expect(updated?.lastError?.code).toBe('ETIMEDOUT');
      expect(updated?.lastError?.retryCount).toBe(1);
      expect(updated?.lastError?.timestamp).toBeDefined();
    });

    it('should increment retry count on subsequent errors', async () => {
      const link = await questExternalLinkRepository.create(createBasicLink());

      // First error
      await questExternalLinkRepository.recordError(link.id, { message: 'Error 1' });

      // Second error
      const updated = await questExternalLinkRepository.recordError(link.id, { message: 'Error 2' });

      expect(updated?.lastError?.retryCount).toBe(2);
      expect(updated?.lastError?.message).toBe('Error 2');
    });
  });

  describe('markSynced', () => {
    it('should mark as synced with version info', async () => {
      // Create link with error
      const link = await questExternalLinkRepository.create(
        createBasicLink({
          status: 'error',
          lastError: { message: 'Previous error', timestamp: new Date(), retryCount: 2 },
        })
      );

      const updated = await questExternalLinkRepository.markSynced(link.id, 'local-v1', 'remote-v1');

      expect(updated?.status).toBe('synced');
      expect(updated?.localVersion).toBe('local-v1');
      expect(updated?.remoteVersion).toBe('remote-v1');
      expect(updated?.lastSyncedAt).toBeDefined();
      // lastError may still exist here: $set does not unset it. What matters is status synced with updated versions.
    });
  });

  describe('capability-specific configs', () => {
    it('should store Slack-specific config', async () => {
      const slackLink = await questExternalLinkRepository.create({
        questPlanId: 'quest-1',
        userId: 'user-1',
        capabilityType: 'slack',
        externalId: 'C123-1234567890.123456',
        externalUrl: 'https://slack.com/archives/C123/p1234567890123456',
        syncDirection: 'push',
        status: 'synced',
        slack: {
          channelId: 'C123',
          threadTs: '1234567890.123456',
          workspaceId: 'T456',
        },
        createdBy: 'user-1',
      });

      expect(slackLink.slack?.channelId).toBe('C123');
      expect(slackLink.slack?.threadTs).toBe('1234567890.123456');
      expect(slackLink.slack?.workspaceId).toBe('T456');
    });

    it('should store Jira-specific config', async () => {
      const jiraLink = await questExternalLinkRepository.create({
        questPlanId: 'quest-1',
        userId: 'user-1',
        capabilityType: 'jira',
        externalId: 'PROJ-123',
        externalUrl: 'https://company.atlassian.net/browse/PROJ-123',
        syncDirection: 'bidirectional',
        status: 'pending',
        jira: {
          projectKey: 'PROJ',
          issueKey: 'PROJ-123',
          cloudId: 'cloud-abc',
        },
        createdBy: 'user-1',
      });

      expect(jiraLink.jira?.projectKey).toBe('PROJ');
      expect(jiraLink.jira?.issueKey).toBe('PROJ-123');
      expect(jiraLink.jira?.cloudId).toBe('cloud-abc');
    });

    it('should store Calendar-specific config', async () => {
      const calendarLink = await questExternalLinkRepository.create({
        questPlanId: 'quest-1',
        userId: 'user-1',
        capabilityType: 'calendar',
        externalId: 'cal-123-event-456',
        externalUrl: 'https://calendar.google.com/event/456',
        syncDirection: 'pull',
        status: 'synced',
        calendar: {
          calendarId: 'cal-123',
          eventId: 'event-456',
          provider: 'google',
        },
        createdBy: 'user-1',
      });

      expect(calendarLink.calendar?.calendarId).toBe('cal-123');
      expect(calendarLink.calendar?.eventId).toBe('event-456');
      expect(calendarLink.calendar?.provider).toBe('google');
    });

    it('should store CLI-specific config', async () => {
      const cliLink = await questExternalLinkRepository.create({
        questPlanId: 'quest-1',
        userId: 'user-1',
        capabilityType: 'cli',
        externalId: 'session-abc',
        externalUrl: 'cli://session/abc',
        syncDirection: 'push',
        status: 'synced',
        cli: {
          sessionId: 'session-abc',
          workingDirectory: '/home/user/project',
        },
        createdBy: 'user-1',
      });

      expect(cliLink.cli?.sessionId).toBe('session-abc');
      expect(cliLink.cli?.workingDirectory).toBe('/home/user/project');
    });
  });
});
