import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import archiver from 'archiver';
import { CreditHolderType, orgAclRowConfersMembership, settingsMap, type SettingDefinition } from '@bike4mind/common';
import { CreditTransaction, UsageEvent } from '@bike4mind/database/billing';
import { OrganizationAuditEventModel, ScopedSetting } from '@bike4mind/database/infra';
import { User, userRepository } from '@bike4mind/database';
import type { Context } from 'aws-lambda';
import type { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import {
  ORGANIZATION_EXPORT_TTL_MS,
  organizationExportKey,
  organizationExportKeysForRequest,
  findOrganizationExportRequest,
  findOrganizationExportObject,
  organizationExportPayload,
  requireOrganizationExportOwner,
} from '@bike4mind/server-utils/utils/organizationDataExport';
import {
  accountExportDeletionDue,
  claimAccountExportLease,
  nextExportLeaseWaits,
  LEASE_WAIT_DELAY_SECONDS,
  MAX_LEASE_WAITS,
  UPLOAD_RESERVE_MS,
} from './accountExportLease';

export const exportCsvCell = (value: unknown) => {
  const text =
    value instanceof Date
      ? value.toISOString()
      : value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
  if (text === undefined) throw new Error('Organization export contains a value that cannot be serialized');
  return `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

export async function* exportCsv(
  rows: AsyncIterable<Record<string, unknown>>,
  columns: string[],
  assertBudget: () => void
) {
  assertBudget();
  yield columns.map(exportCsvCell).join(',') + '\r\n';
  for await (const row of rows) {
    assertBudget();
    yield columns.map(column => exportCsvCell(row[column])).join(',') + '\r\n';
  }
}

export async function buildOrganizationDataExport(
  raw: unknown,
  context: Pick<Context, 'getRemainingTimeInMillis'>,
  logger: Pick<Logger, 'updateMetadata' | 'info' | 'error'>,
  receiveCount = 1
) {
  const { id: requestedId, userId, exportJobId, leaseWaits = 0 } = organizationExportPayload.parse(raw);
  logger.updateMetadata({
    kind: 'organization',
    organizationId: requestedId,
    userId,
    exportJobId,
    leaseWaits,
    receiveCount,
  });
  const request = await findOrganizationExportRequest(requestedId, userId, exportJobId);
  if (!request || request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS <= Date.now()) return;
  const keys = organizationExportKeysForRequest(requestedId, userId, exportJobId, request);
  const storage = getFilesStorage();
  const eraseArtifacts = async () => {
    for (const key of keys) await storage.deletePermanently(key);
  };
  const skipUnavailableAccount = async () => {
    await eraseArtifacts();
    logger.info('Organization data export skipped: account is gone or permanent deletion is due');
  };
  const user = await userRepository.findById(userId);
  if (!user || accountExportDeletionDue(user)) {
    await skipUnavailableAccount();
    return;
  }
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) throw new Error('APP_URL is required for organization exports');
  const lease = await claimAccountExportLease(userId, exportJobId, 'Organization data export');
  if (!lease) {
    const current = await userRepository.findById(userId);
    if (!current || accountExportDeletionDue(current)) {
      await skipUnavailableAccount();
      return;
    }
    const ownLease = await User.exists({ _id: userId, 'accountDataExportLease.jobId': exportJobId });
    const nextWaits = nextExportLeaseWaits(leaseWaits, receiveCount);
    const queueUrl = Resource.accountDataExportQueue?.url;
    if (!ownLease && nextWaits <= MAX_LEASE_WAITS && queueUrl) {
      await sendToQueue(
        queueUrl,
        {
          kind: 'organization',
          id: requestedId,
          userId,
          exportJobId,
          leaseWaits: nextWaits,
        },
        LEASE_WAIT_DELAY_SECONDS
      );
      logger.info('Organization data export deferred: another export holds the account lease');
      return;
    }
    throw new Error(
      ownLease
        ? 'An earlier attempt of this organization export still holds the account lease'
        : 'Another export holds the account lease'
    );
  }
  const failureAudit = { organizationId: requestedId, actorUserId: userId, targetId: exportJobId };
  try {
    const assertAuthority = async () => {
      try {
        await lease.assertActive();
        const currentOrg = await requireOrganizationExportOwner({ id: userId }, requestedId);
        if (request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS <= Date.now())
          throw new Error('Organization export request expired');
        return currentOrg;
      } catch (error) {
        try {
          await eraseArtifacts();
        } catch (cleanupError) {
          logger.error('Organization export authority lost; artifact cleanup failed', { cleanupError });
        }
        throw error;
      }
    };
    const org = await assertAuthority();
    const id = org.id;
    const audit = { organizationId: id, actorUserId: userId, targetId: exportJobId };
    const notify = async () => {
      await assertAuthority();
      const email = lease.deliveryEmail || user.email;
      if (!email) return;
      const url = `${appUrl.replace(/\/+$/, '')}/organizations/${id}?tab=settings`;
      await EmailEvents.Send.publish({
        to: email,
        subject: 'Your organization data export is ready',
        body: `<p>Your organization metadata and CSV export is ready. Projects, notebooks and files are excluded.</p><p><a href="${escapeHtml(url)}">Download from organization settings</a></p><p>Sign in as the organization owner. The export expires at ${new Date(request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS).toISOString()}.</p>`,
      });
    };
    const existing = await findOrganizationExportObject(storage, id, userId, exportJobId, request);
    if (existing) {
      await notify();
      return;
    }
    const assertBuildBudget = () => {
      if (context.getRemainingTimeInMillis() <= UPLOAD_RESERVE_MS)
        throw new Error('No remaining time to complete the organization export archive');
    };
    assertBuildBudget();
    const key = organizationExportKey(id, userId, exportJobId);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'organization-export-'));
    const archive = archiver('zip', { zlib: { level: 6 } });
    const output = createWriteStream(path.join(dir, 'organization-data.zip'));
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          assertBuildBudget();
          bytes += chunk.length;
          callback(bytes > 4 * 1024 ** 3 ? new Error('Organization export exceeds 4 GB') : null, chunk);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    const closed = new Promise<void>((resolve, reject) => {
      output.once('close', resolve);
      // Several CSV streams can fail together as a deadline expires. Keep error handlers
      // attached through abort/cleanup so later errors cannot escape the rejected build.
      output.on('error', reject);
      archive.on('error', reject);
      bounded.on('error', reject);
    });
    // The archive can fail before it reaches the final await; keep its rejection handled until then.
    void closed.catch(() => undefined);
    archive.pipe(bounded).pipe(output);
    const streams: Readable[] = [];
    const appendCsv = (rows: AsyncIterable<Record<string, unknown>>, columns: string[], name: string) => {
      const stream = Readable.from(exportCsv(rows, columns, assertBuildBudget));
      streams.push(stream);
      stream.on('error', error => archive.emit('error', error));
      archive.append(stream, { name });
    };
    try {
      archive.append(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            organizationId: id,
            contentIncluded: false,
            excluded: ['projects', 'notebooks', 'files', 'credentials', 'transaction descriptions and metadata'],
            consistency: 'Live records read during export; not a transactional snapshot.',
            files: ['settings.json', 'members.csv', 'scoped-settings.csv', 'usage.csv', 'ledger.csv', 'audit.csv'],
          },
          null,
          2
        ),
        { name: 'manifest.json' }
      );
      archive.append(
        JSON.stringify(
          {
            id,
            name: org.name,
            description: org.description,
            personal: org.personal,
            ownerId: org.userId,
            billingContact: org.billingContact,
            seats: org.seats,
            storageLimit: org.storageLimit,
            maxCreditsPerMember: org.maxCreditsPerMember,
            redactPushContent: org.redactPushContent,
            allowedGroupTypes: org.allowedGroupTypes,
          },
          null,
          2
        ),
        { name: 'settings.json' }
      );
      const memberIds = new Set([
        userId,
        ...(org.users ?? []).filter(orgAclRowConfersMembership).map(row => row.userId),
      ]);
      const members = [...memberIds].map(memberId => ({
        userId: memberId,
        role: memberId === userId ? 'owner' : (org.adminUserIds ?? []).includes(memberId) ? 'manager' : 'member',
        maxCredits: org.userDetails?.find(row => row.id === memberId)?.maxCredits,
      }));
      appendCsv(Readable.from(members), ['userId', 'role', 'maxCredits'], 'members.csv');
      const safeSettings = Object.entries(settingsMap)
        .filter(([, definition]) => {
          const setting: SettingDefinition = definition;
          return !setting.isSensitive && setting.scope;
        })
        .map(([name]) => name);
      const scoped = ScopedSetting.find({
        scopeId: id,
        deletedAt: null,
        settingName: { $in: safeSettings },
        $or: [{ scopeLevel: 'organization' }, { scopeLevel: 'owner', ownerType: CreditHolderType.Organization }],
      })
        .select('scopeLevel settingName settingValue')
        .lean()
        .cursor();
      appendCsv(scoped, ['scopeLevel', 'settingName', 'settingValue'], 'scoped-settings.csv');
      const owner = { ownerId: id, ownerType: CreditHolderType.Organization };
      const usageColumns = [
        '_id',
        'createdAt',
        'userId',
        'feature',
        'provider',
        'model',
        'inputTokens',
        'outputTokens',
        'cachedInputTokens',
        'creditsCharged',
        'status',
      ];
      const ledgerColumns = [
        '_id',
        'createdAt',
        'type',
        'credits',
        'amount',
        'status',
        'model',
        'inputTokens',
        'outputTokens',
        'source',
      ];
      const auditColumns = ['occurredAt', 'actorUserId', 'action', 'targetId'];
      appendCsv(UsageEvent.find(owner).select(usageColumns.join(' ')).lean().cursor(), usageColumns, 'usage.csv');
      appendCsv(
        CreditTransaction.find(owner).select(ledgerColumns.join(' ')).lean().cursor(),
        ledgerColumns,
        'ledger.csv'
      );
      appendCsv(
        OrganizationAuditEventModel.find({ organizationId: id }).select(auditColumns.join(' ')).lean().cursor(),
        auditColumns,
        'audit.csv'
      );
      await Promise.all([archive.finalize(), closed]);
      await assertAuthority();
      await lease.upload({
        storage,
        localPath: path.join(dir, 'organization-data.zip'),
        key,
        remainingMs: () => context.getRemainingTimeInMillis(),
        logger,
      });
      await assertAuthority();
      await recordOrganizationAuditEvent({ ...audit, action: 'export.completed' });
      await notify();
    } catch (error) {
      archive.abort();
      bounded.destroy();
      output.destroy();
      throw error;
    } finally {
      for (const stream of streams) stream.destroy();
      await fs.rm(dir, { recursive: true, force: true });
    }
  } catch (error) {
    try {
      await recordOrganizationAuditEvent({ ...failureAudit, action: 'export.failed' });
    } catch (auditError) {
      logger.error('Organization export failure audit could not be recorded', { auditError });
    }
    throw error;
  } finally {
    await lease.release();
  }
}
