import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { Readable, Transform } from 'stream';
import archiver from 'archiver';
import { CreditHolderType, orgAclRowConfersMembership, settingsMap, type SettingDefinition } from '@bike4mind/common';
import { CreditTransaction, UsageEvent } from '@bike4mind/database/billing';
import { OrganizationAuditEventModel, ScopedSetting } from '@bike4mind/database/infra';
import { userRepository } from '@bike4mind/database';
import { EmailEvents } from '@bike4mind/server-utils/utils/eventBus';
import { escapeHtml } from '@bike4mind/server-utils/utils/mailer/emailHelpers';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { isMissingObjectError } from '@bike4mind/server-utils/utils/accountDataExport';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import {
  ORGANIZATION_EXPORT_TTL_MS,
  organizationExportKey,
  organizationExportPayload,
  requireOrganizationExportOwner,
} from '@bike4mind/server-utils/utils/organizationDataExport';

export const exportCsvCell = (value: unknown) => {
  const text = value instanceof Date ? value.toISOString() : String(value ?? '');
  return `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
};

export async function* exportCsv(rows: AsyncIterable<Record<string, unknown>>, columns: string[]) {
  yield columns.map(exportCsvCell).join(',') + '\r\n';
  for await (const row of rows) yield columns.map(column => exportCsvCell(row[column])).join(',') + '\r\n';
}

export async function buildOrganizationDataExport(raw: unknown) {
  const { id, userId, exportJobId } = organizationExportPayload.parse(raw);
  const audit = { organizationId: id, actorUserId: userId, targetId: exportJobId };
  const request = await OrganizationAuditEventModel.findOne({ ...audit, action: 'export.requested' }).lean();
  if (!request || request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS <= Date.now()) return;
  const org = await requireOrganizationExportOwner({ id: userId }, id);
  const appUrl = process.env.APP_URL?.trim();
  if (!appUrl) throw new Error('APP_URL is required for organization exports');
  const notify = async () => {
    await requireOrganizationExportOwner({ id: userId }, id);
    const user = await userRepository.findById(userId);
    if (!user?.email) return;
    const url = `${appUrl.replace(/\/+$/, '')}/organizations/${id}?tab=settings`;
    await EmailEvents.Send.publish({
      to: user.email,
      subject: 'Your organization data export is ready',
      body: `<p>Your organization metadata and CSV export is ready. Projects, notebooks and files are excluded.</p><p><a href="${escapeHtml(url)}">Download from organization settings</a></p><p>Sign in as the organization owner. The export expires at ${new Date(request.occurredAt.getTime() + ORGANIZATION_EXPORT_TTL_MS).toISOString()}.</p>`,
    });
  };
  const storage = getFilesStorage();
  const key = organizationExportKey(id, userId, exportJobId);
  try {
    await storage.getMetadata(key);
    await notify();
    return;
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'organization-export-'));
  const archive = archiver('zip', { zlib: { level: 6 } });
  const output = createWriteStream(path.join(dir, 'organization-data.zip'));
  let bytes = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 4 * 1024 ** 3 ? new Error('Organization export exceeds 4 GB') : null, chunk);
    },
  });
  const closed = new Promise<void>((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    bounded.once('error', reject);
  });
  closed.catch(() => undefined);
  archive.pipe(bounded).pipe(output);
  const streams: Readable[] = [];
  const appendCsv = (rows: AsyncIterable<Record<string, unknown>>, columns: string[], name: string) => {
    const stream = Readable.from(exportCsv(rows, columns));
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
    const memberIds = new Set([userId, ...(org.users ?? []).filter(orgAclRowConfersMembership).map(row => row.userId)]);
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
    await requireOrganizationExportOwner({ id: userId }, id);
    await storage.uploadFile(
      path.join(dir, 'organization-data.zip'),
      key,
      { ContentType: 'application/zip' },
      AbortSignal.timeout(5 * 60 * 1000)
    );
    await recordOrganizationAuditEvent({ ...audit, action: 'export.completed' });
    await notify();
  } catch (error) {
    archive.abort();
    bounded.destroy();
    output.destroy();
    await recordOrganizationAuditEvent({ ...audit, action: 'export.failed' });
    throw error;
  } finally {
    for (const stream of streams) stream.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
