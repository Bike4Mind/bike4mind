import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import type { AdminAuditAction, AuditContext, IAdminAuditLogRepository } from '@bike4mind/common';
import {
  AdminAuditLogModel,
  AuthSessionModel,
  CreditTransaction,
  PasskeyCredentialModel,
  TrustedDeviceModel,
  adminAuditLogRepository,
  authSessionRepository,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
  User,
  withTransaction,
} from '@bike4mind/database';
import {
  AdminSettings,
  EmailJob,
  Organization,
  SlackDevWorkspace,
  emailJobRepository,
  organizationRepository,
  scopedSettingsRepository,
  slackDevWorkspaceRepository,
} from '@bike4mind/database/infra';
import {
  CreditHolderType,
  EmailCategory,
  EmailJobOverallStatus,
  EmailJobStatus,
} from '@bike4mind/common';
import {
  adminAuditService,
  authSessionService,
  creditService,
  mfaService,
  scopedSettingsService,
} from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// A strict (critical) action and its audit entry commit together or not at all. A standalone mongod
// cannot run transactions, so only a replica set can tell a rolled-back write from one that escaped.

let replSet: MongoMemoryReplSet;

beforeAll(async () => {
  replSet = await createMongoReplSet();
  await mongoose.connect(replSet.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const context: AuditContext = { source: 'admin_ui', route: '/api/test' };
const actor = { kind: 'user' as const, scope: 'platform' as const, userId: 'admin-1', name: 'Admin', wasAdmin: true };

const failingStore: Pick<IAdminAuditLogRepository, 'append'> = {
  append: () => Promise.reject(new Error('audit store unavailable')),
};

const record = (action: AdminAuditAction, store: Pick<IAdminAuditLogRepository, 'append'>, targetId: string) =>
  adminAuditService.recordAdminAction(
    { action, actor, context, target: { kind: 'user', id: targetId, displayName: 'Target' }, summary: 'test' },
    { db: { adminAuditLog: store }, logger: { error: () => undefined } }
  );

const seedUser = async (isAdmin = false) =>
  User.create({
    name: 'Target',
    username: `target-${Math.random().toString(36).slice(2, 10)}`,
    password: null,
    hasUsablePassword: false,
    isAdmin,
  });

const isAdminNow = async (id: string) => (await User.findById(id).lean())?.isAdmin;

describe('strict admin audit writes roll back the action on a real replica set', () => {
  it('a failed audit write leaves a role grant uncommitted', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
        await record('user.role.admin_granted', failingStore, user.id);
      })
    ).rejects.toThrow('audit store unavailable');

    expect(await isAdminNow(user.id)).toBe(false);
    expect(await AdminAuditLogModel.countDocuments()).toBe(0);
  });

  it('a failed audit write leaves a user deletion uncommitted', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await userRepository.delete(user.id);
        await record('user.deleted', failingStore, user.id);
      })
    ).rejects.toThrow('audit store unavailable');

    expect(await userRepository.findById(user.id)).not.toBeNull();
  });

  it('a failed audit write leaves an admin settings edit uncommitted', async () => {
    await AdminSettings.create({ settingName: 'EnableUserDeletionSlackNotification', settingValue: false });

    await expect(
      withTransaction(async () => {
        await AdminSettings.findOneAndUpdate(
          { settingName: 'EnableUserDeletionSlackNotification' },
          { $set: { settingValue: true } }
        );
        await record('settings.admin_settings.updated', failingStore, 'EnableUserDeletionSlackNotification');
      })
    ).rejects.toThrow('audit store unavailable');

    const stored = await AdminSettings.findOne({ settingName: 'EnableUserDeletionSlackNotification' }).lean();
    expect(stored?.settingValue).toBe(false);
  });

  it('a failed audit write leaves a scoped-settings override uncommitted', async () => {
    const address = { scopeLevel: 'lake' as const, scopeId: 'lake-1' };

    await expect(
      withTransaction(async () => {
        await scopedSettingsService.writeScopedOverride(
          'PauseLakeConvergence',
          address,
          'true',
          { scopedSettings: scopedSettingsRepository },
          {}
        );
        await record('settings.admin_settings.updated', failingStore, 'PauseLakeConvergence@lake:lake-1');
      })
    ).rejects.toThrow('audit store unavailable');

    expect(await scopedSettingsRepository.find({})).toHaveLength(0);
  });

  it('a failed audit write rolls back a write made through the separate infra repository entry', async () => {
    const workspace = await SlackDevWorkspace.create({ slackAppId: 'A123', name: 'Acme', isActive: true });

    await expect(
      withTransaction(async () => {
        await slackDevWorkspaceRepository.deactivate(workspace.id);
        await record('integration.slack_workspace.deactivated', failingStore, workspace.id);
      })
    ).rejects.toThrow('audit store unavailable');

    expect((await SlackDevWorkspace.findById(workspace.id).lean())?.isActive).toBe(true);
  });

  it('an entry the real store rejects also rolls the action back', async () => {
    const user = await seedUser();

    await expect(
      withTransaction(async () => {
        await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
        // An empty summary fails schema validation inside the same session.
        await adminAuditService.recordAdminAction(
          {
            action: 'user.role.admin_granted',
            actor,
            context,
            target: { kind: 'user', id: user.id, displayName: 'Target' },
            summary: '',
          },
          { db: { adminAuditLog: adminAuditLogRepository } }
        );
      })
    ).rejects.toThrow();

    expect(await isAdminNow(user.id)).toBe(false);
  });

  it('commits the action and its entry together when the audit write succeeds', async () => {
    const user = await seedUser();

    await withTransaction(async () => {
      await User.updateOne({ _id: user._id }, { $set: { isAdmin: true } });
      await record('user.role.admin_granted', adminAuditLogRepository, user.id);
    });

    expect(await isAdminNow(user.id)).toBe(true);
    expect(await AdminAuditLogModel.countDocuments({ action: 'user.role.admin_granted', 'target.id': user.id })).toBe(
      1
    );
  });

  it('a best-effort action still commits when its audit write fails', async () => {
    const user = await seedUser(true);

    await withTransaction(async () => {
      await User.updateOne({ _id: user._id }, { $set: { name: 'Renamed' } });
      await record('user.impersonation.ended', failingStore, user.id);
    });

    expect((await User.findById(user.id).lean())?.name).toBe('Renamed');
  });

  describe('multi-write strict paths', () => {
    const recordFor = (
      action: AdminAuditAction,
      store: Pick<IAdminAuditLogRepository, 'append'>,
      target: { kind: 'organization' | 'user'; id: string }
    ) =>
      adminAuditService.recordAdminAction(
        { action, actor, context, target: { ...target, displayName: 'Target' }, summary: 'test' },
        { db: { adminAuditLog: store }, logger: { error: () => undefined } }
      );

    const seedOrganization = async (userId: string) =>
      Organization.create({ name: 'Acme', userId, currentCredits: 100 });

    const adjustOrgCredits = (orgId: string) =>
      creditService.addCredits(
        {
          ownerId: orgId,
          ownerType: CreditHolderType.Organization,
          credits: 50,
          reason: 'admin_adjustment',
          description: 'goodwill grant',
          type: 'generic_add',
        },
        {
          db: { creditTransactions: creditTransactionRepository, creditLots: creditLotRepository },
          creditHolderMethods: organizationRepository,
        }
      );

    const orgState = async (id: string) => {
      const org = await Organization.findById(id).lean();
      return {
        balance: org?.currentCredits,
        name: org?.name,
        ledgerRows: await CreditTransaction.countDocuments({ ownerId: id }),
        auditRows: await AdminAuditLogModel.countDocuments(),
      };
    };

    it('a failed audit write leaves an admin org credit edit and profile update uncommitted', async () => {
      const org = await seedOrganization('owner-1');

      await expect(
        withTransaction(async () => {
          await adjustOrgCredits(org.id);
          await recordFor('org.credits.adjusted', failingStore, { kind: 'organization', id: org.id });
          await Organization.updateOne({ _id: org._id }, { $set: { name: 'Renamed' } });
        })
      ).rejects.toThrow('audit store unavailable');

      expect(await orgState(org.id)).toEqual({ balance: 100, name: 'Acme', ledgerRows: 0, auditRows: 0 });
    });

    it('a failed profile update after the credit edit rolls the ledger row and audit entry back', async () => {
      const org = await seedOrganization('owner-1');

      await expect(
        withTransaction(async () => {
          await adjustOrgCredits(org.id);
          await recordFor('org.credits.adjusted', adminAuditLogRepository, { kind: 'organization', id: org.id });
          throw new Error('profile update failed');
        })
      ).rejects.toThrow('profile update failed');

      expect(await orgState(org.id)).toEqual({ balance: 100, name: 'Acme', ledgerRows: 0, auditRows: 0 });
    });

    it('a failed audit write leaves no impersonation session document', async () => {
      const target = await seedUser();

      await expect(
        withTransaction(async () => {
          const session = await authSessionService.issueSession(
            target.id,
            { createdVia: 'impersonation', tokenVersion: 0, impersonatedBy: 'admin-1' },
            {
              db: { authSessions: authSessionRepository },
              signAccessToken: async () => 'access-token',
            }
          );
          await recordFor('user.impersonation.started', failingStore, { kind: 'user', id: target.id });
          return session;
        })
      ).rejects.toThrow('audit store unavailable');

      expect(await AuthSessionModel.countDocuments({ userId: target.id })).toBe(0);
    });

    it('a failed audit write leaves an MFA force-reset fully uncommitted', async () => {
      const target = await seedUser();
      await User.updateOne(
        { _id: target._id },
        { $set: { mfa: { totpSecret: 'secret', totpEnabled: true, backupCodes: [], setupAt: new Date() } } }
      );
      await PasskeyCredentialModel.create({
        userId: target.id,
        credentialId: 'cred-1',
        publicKey: 'pk',
        counter: 0,
        deviceType: 'singleDevice',
        backedUp: false,
        name: 'Key',
      });
      await TrustedDeviceModel.create({
        userId: target.id,
        tokenHash: 'hash-1',
        label: 'Laptop',
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      const admin = await seedUser(true);

      await expect(
        withTransaction(async () => {
          await PasskeyCredentialModel.deleteMany({ userId: target.id });
          await mfaService.forceResetMFA({ targetUserId: target.id, adminUser: admin }, userRepository);
          await TrustedDeviceModel.deleteMany({ userId: target.id });
          await recordFor('user.mfa.reset', failingStore, { kind: 'user', id: target.id });
        })
      ).rejects.toThrow('audit store unavailable');

      expect(await PasskeyCredentialModel.countDocuments({ userId: target.id })).toBe(1);
      expect(await TrustedDeviceModel.countDocuments({ userId: target.id })).toBe(1);
      expect((await User.findById(target.id).lean())?.mfa?.totpEnabled).toBe(true);
    });
  });

  describe('email job claims', () => {
    const seedJob = (overallStatus = EmailJobOverallStatus.DRAFT) =>
      EmailJob.create({
        name: 'Launch',
        templateId: 'tpl-1',
        category: EmailCategory.MARKETING,
        createdBy: 'admin-1',
        status: EmailJobStatus.DRAFT,
        overallStatus,
      });

    const jobState = async (id: string) => {
      const job = await EmailJob.findById(id).lean();
      return {
        status: job?.status,
        overallStatus: job?.overallStatus,
        lastSentAt: job?.lastSentAt,
        startedBy: job?.startedBy,
      };
    };

    it('a failed audit write leaves a send claim uncommitted', async () => {
      const job = await seedJob(EmailJobOverallStatus.COMPLETE);
      const before = await jobState(job.id);

      await expect(
        withTransaction(async () => {
          await emailJobRepository.claimForSending(job.id, { lastSentAt: new Date(), lastSentBy: 'admin-1' });
          await record('email.job.sent', failingStore, job.id);
        })
      ).rejects.toThrow('audit store unavailable');

      expect(await jobState(job.id)).toEqual(before);
    });

    it('a failed audit write leaves a start claim uncommitted', async () => {
      const job = await seedJob();

      await expect(
        withTransaction(async () => {
          await emailJobRepository.claimForStart(job.id, { startedBy: 'admin-1' });
          await record('email.job.started', failingStore, job.id);
        })
      ).rejects.toThrow('audit store unavailable');

      expect(await jobState(job.id)).toMatchObject({ status: EmailJobStatus.DRAFT, startedBy: undefined });
    });

    it('commits a start claim with its audit entry and refuses a second claim', async () => {
      const job = await seedJob();

      const claim = () =>
        withTransaction(async () => {
          const claimed = await emailJobRepository.claimForStart(job.id, { startedBy: 'admin-1' });
          if (claimed) await record('email.job.started', adminAuditLogRepository, job.id);
          return claimed;
        });

      expect(await claim()).not.toBeNull();
      expect(await claim()).toBeNull();
      expect(await jobState(job.id)).toMatchObject({ status: EmailJobStatus.QUEUED, startedBy: 'admin-1' });
      expect(await AdminAuditLogModel.countDocuments({ action: 'email.job.started' })).toBe(1);
    });

    it('an error thrown after a send claim restores the previous overall status', async () => {
      const job = await seedJob(EmailJobOverallStatus.COMPLETE);

      await expect(
        withTransaction(async () => {
          await emailJobRepository.claimForSending(job.id, { lastSentAt: new Date(), lastSentBy: 'admin-1' });
          throw new BadRequestError('Test mode requires at least one test recipient email address.');
        })
      ).rejects.toThrow('Test mode requires');

      expect(await jobState(job.id)).toMatchObject({ overallStatus: EmailJobOverallStatus.COMPLETE });
    });
  });
});
