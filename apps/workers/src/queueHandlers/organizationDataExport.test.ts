import { readFile } from 'fs/promises';
import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import yauzl from 'yauzl';

const h = vi.hoisted(() => ({
  org: vi.fn(),
  request: vi.fn(),
  metadata: vi.fn(),
  upload: vi.fn(),
  audit: vi.fn(),
  usage: vi.fn(),
  ledger: vi.fn(),
  scoped: vi.fn(),
  events: vi.fn(),
  user: vi.fn(),
  email: vi.fn(),
  claim: vi.fn(),
  exists: vi.fn(),
  leaseUpdate: vi.fn(),
  erase: vi.fn(),
  send: vi.fn(),
  requestQuery: vi.fn(),
}));
const cursor = (rows: Record<string, unknown>[]) => ({
  select: () => ({ lean: () => ({ cursor: () => Readable.from(rows) }) }),
});
vi.mock('@bike4mind/database/billing', () => ({
  UsageEvent: { find: h.usage },
  CreditTransaction: { find: h.ledger },
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.user },
  User: { findOneAndUpdate: () => ({ lean: h.claim }), exists: h.exists, updateOne: h.leaseUpdate },
}));
vi.mock('sst', () => ({ Resource: { accountDataExportQueue: { url: 'queue' } } }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ sendToQueue: h.send }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.email } } }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: h.org },
  ScopedSetting: { find: h.scoped },
  OrganizationAuditEventModel: {
    findOne: (...args: unknown[]) => {
      h.requestQuery(...args);
      return { lean: h.request };
    },
    find: h.events,
  },
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEvent: h.audit }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: h.metadata, uploadFile: h.upload, deletePermanently: h.erase }),
}));
import { buildOrganizationDataExport, exportCsvCell } from './organizationDataExport';
const payload = {
  kind: 'organization',
  id: 'a'.repeat(24),
  userId: 'owner',
  exportJobId: '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70',
};
const context = { getRemainingTimeInMillis: vi.fn(() => 15 * 60 * 1000) };
const logger = { updateMetadata: vi.fn(), info: vi.fn(), error: vi.fn() };
const runExport = (raw: unknown) => buildOrganizationDataExport(raw, context, logger);
const requestFor = (occurredAt = new Date()) => ({
  organizationId: payload.id,
  actorUserId: payload.userId,
  targetId: payload.exportJobId,
  occurredAt,
});

async function unzip(bytes: Buffer): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const entries: Record<string, string> = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(entries));
      zip.on('entry', entry =>
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return reject(err);
          const chunks: Buffer[] = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            entries[entry.fileName] = Buffer.concat(chunks).toString();
            zip.readEntry();
          });
        })
      );
      zip.readEntry();
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('APP_URL', 'https://app.example.test');
  h.user.mockResolvedValue({ email: 'owner@example.test' });
  h.org.mockResolvedValue({
    id: payload.id,
    userId: 'owner',
    name: 'Example',
    users: [
      { userId: 'manager', permissions: ['read'] },
      { userId: 'stale', permissions: [] },
    ],
    adminUserIds: ['manager'],
    stripeCustomerId: 'not-exported',
    systemPrompt: 'not-exported',
  });
  h.request.mockResolvedValue(requestFor());
  h.claim.mockResolvedValue({ email: 'owner@example.test' });
  h.exists.mockResolvedValue({ _id: 'owner' });
  h.leaseUpdate.mockResolvedValue({ matchedCount: 1 });
  h.erase.mockResolvedValue(undefined);
  h.send.mockResolvedValue(undefined);
  context.getRemainingTimeInMillis.mockReturnValue(15 * 60 * 1000);
  h.metadata.mockRejectedValue(Object.assign(new Error('Missing'), { name: 'NotFound' }));
  h.upload.mockResolvedValue(undefined);
  h.usage.mockReturnValue(cursor([{ _id: 'usage', creditsCharged: 5, metadata: 'not-exported' }]));
  h.ledger.mockReturnValue(cursor([{ _id: 'ledger', credits: 5, description: 'not-exported' }]));
  h.scoped.mockReturnValue(cursor([]));
  h.events.mockReturnValue(cursor([{ action: 'export.requested' }]));
});

describe('organization metadata export worker', () => {
  it('exports structured policies and arrays as JSON while canonicalizing upper-case queue ids', async () => {
    const policy = { mode: 'allowlist', allowedHostPatterns: ['corp.example'] };
    h.scoped.mockReturnValue(
      cursor([
        { scopeLevel: 'organization', settingName: 'customMcpPolicy', settingValue: policy },
        { scopeLevel: 'organization', settingName: 'allowedModels', settingValue: ['one', 'two'] },
      ])
    );
    let entries: Record<string, string> = {};
    h.upload.mockImplementation(async (file: string) => {
      entries = await unzip(await readFile(file));
    });
    await runExport({ ...payload, id: payload.id.toUpperCase() });
    expect(entries['scoped-settings.csv']).toContain(exportCsvCell(policy));
    expect(entries['scoped-settings.csv']).toContain(exportCsvCell(['one', 'two']));
    expect(entries['scoped-settings.csv']).not.toContain('[object Object]');
    expect(JSON.parse(entries['manifest.json']).organizationId).toBe(payload.id);
    expect(h.usage).toHaveBeenCalledWith({ ownerId: payload.id, ownerType: 'Organization' });
    expect(h.upload).toHaveBeenCalledWith(
      expect.any(String),
      `exports/organization-data/owner/${payload.id}/${payload.exportJobId}.zip`,
      expect.any(Object),
      expect.any(AbortSignal)
    );
  });

  it('defers before reading organization data when the shared account lease is held', async () => {
    h.claim.mockResolvedValue(null);
    h.exists.mockResolvedValue(null);
    await runExport(payload);
    expect(h.send).toHaveBeenCalledWith('queue', { ...payload, leaseWaits: 1 }, 120);
    expect(h.usage).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('keeps the shared account fence after an ambiguous upload and preserves the primary error', async () => {
    const failure = new Error('ambiguous PUT');
    h.upload.mockRejectedValue(failure);
    h.erase.mockRejectedValue(new Error('cleanup failed'));
    await expect(runExport(payload)).rejects.toBe(failure);
    expect(h.leaseUpdate.mock.calls.some(([, update]) => '$unset' in update)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ambiguous upload'), expect.any(Object));
    expect(h.email).not.toHaveBeenCalled();
  });

  it('fails before building or uploading when the invocation cannot reserve upload time', async () => {
    context.getRemainingTimeInMillis.mockReturnValue(5 * 60 * 1000);
    await expect(runExport(payload)).rejects.toThrow('No remaining time');
    expect(h.usage).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.email).not.toHaveBeenCalled();
  });

  it('rejects the whole archive when its time budget expires while consuming a database cursor', async () => {
    async function* exhaustedRows() {
      context.getRemainingTimeInMillis.mockReturnValue(5 * 60 * 1000);
      yield { _id: 'last-row', creditsCharged: 5 };
    }
    h.usage.mockReturnValue({ select: () => ({ lean: () => ({ cursor: exhaustedRows }) }) });
    await expect(runExport(payload)).rejects.toThrow('No remaining time');
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.email).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'export.completed' }));
  });

  it('removes a completed PUT if the real account lease check is lost after upload', async () => {
    h.upload.mockImplementation(async () => {
      h.exists.mockResolvedValue(null);
    });
    await expect(runExport(payload)).rejects.toThrow('lease lost after upload');
    expect(h.erase).toHaveBeenCalledWith(`exports/organization-data/owner/${payload.id}/${payload.exportJobId}.zip`);
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'export.completed' }));
    expect(h.email).not.toHaveBeenCalled();
  });

  it('builds an allowlisted CSV bundle and audits completion only after upload', async () => {
    let entries: Record<string, string> = {};
    h.upload.mockImplementation(async (file: string) => {
      entries = await unzip(await readFile(file));
    });
    await runExport(payload);
    expect(Object.keys(entries).sort()).toEqual([
      'audit.csv',
      'ledger.csv',
      'manifest.json',
      'members.csv',
      'scoped-settings.csv',
      'settings.json',
      'usage.csv',
    ]);
    expect(JSON.parse(entries['manifest.json']).contentIncluded).toBe(false);
    expect(entries['members.csv']).toContain('"manager","manager"');
    expect(entries['members.csv']).not.toContain('stale');
    expect(JSON.stringify(entries)).not.toContain('not-exported');
    expect(h.usage).toHaveBeenCalledWith({ ownerId: payload.id, ownerType: 'Organization' });
    expect(h.ledger).toHaveBeenCalledWith({ ownerId: payload.id, ownerType: 'Organization' });
    expect(h.events).toHaveBeenCalledWith({ organizationId: payload.id });
    expect(h.scoped).toHaveBeenCalledWith(expect.objectContaining({ scopeId: payload.id, deletedAt: null }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'export.completed' }));
    expect(h.upload.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
    expect(h.email).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        body: expect.stringContaining(`/organizations/${payload.id}?tab=settings`),
      })
    );
  });

  it('does not rebuild an existing export or resurrect an expired job', async () => {
    h.metadata.mockResolvedValue({});
    await runExport(payload);
    expect(h.upload).not.toHaveBeenCalled();
    h.request.mockResolvedValue(requestFor(new Date(0)));
    await runExport(payload);
    expect(h.usage).not.toHaveBeenCalled();
  });

  it('rejects a former owner before reading organization records', async () => {
    h.org.mockResolvedValue({ userId: 'successor' });
    await expect(runExport(payload)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.usage).not.toHaveBeenCalled();
  });

  it('rechecks ownership before upload', async () => {
    h.org.mockResolvedValueOnce({ id: payload.id, userId: 'owner' }).mockResolvedValue({ userId: 'successor' });
    await expect(runExport(payload)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'export.failed' }));
  });

  it('does not report completion on upload failure', async () => {
    h.upload.mockRejectedValue(new Error('upload failed'));
    await expect(runExport(payload)).rejects.toThrow('upload failed');
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'export.completed' }));
  });

  it('neutralizes CSV formulas and escapes quotes and newlines', () => {
    expect(exportCsvCell(' =1+1')).toBe('"\' =1+1"');
    expect(exportCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
});
