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
}));
const cursor = (rows: Record<string, unknown>[]) => ({
  select: () => ({ lean: () => ({ cursor: () => Readable.from(rows) }) }),
});
vi.mock('@bike4mind/database/billing', () => ({
  UsageEvent: { find: h.usage },
  CreditTransaction: { find: h.ledger },
}));
vi.mock('@bike4mind/database', () => ({ userRepository: { findById: h.user } }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ EmailEvents: { Send: { publish: h.email } } }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository: { findById: h.org },
  ScopedSetting: { find: h.scoped },
  OrganizationAuditEventModel: { findOne: () => ({ lean: h.request }), find: h.events },
}));
vi.mock('@bike4mind/server-utils/utils/organizationAudit', () => ({ recordOrganizationAuditEvent: h.audit }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ getMetadata: h.metadata, uploadFile: h.upload }),
}));
import { buildOrganizationDataExport, exportCsvCell } from './organizationDataExport';
const payload = {
  kind: 'organization',
  id: 'a'.repeat(24),
  userId: 'owner',
  exportJobId: '7d0c1f5e-9a7b-4c1e-8f0a-2b3c4d5e6f70',
};

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
  h.request.mockResolvedValue({ occurredAt: new Date() });
  h.metadata.mockRejectedValue(Object.assign(new Error('Missing'), { name: 'NotFound' }));
  h.upload.mockResolvedValue(undefined);
  h.usage.mockReturnValue(cursor([{ _id: 'usage', creditsCharged: 5, metadata: 'not-exported' }]));
  h.ledger.mockReturnValue(cursor([{ _id: 'ledger', credits: 5, description: 'not-exported' }]));
  h.scoped.mockReturnValue(cursor([]));
  h.events.mockReturnValue(cursor([{ action: 'export.requested' }]));
});

describe('organization metadata export worker', () => {
  it('builds an allowlisted CSV bundle and audits completion only after upload', async () => {
    let entries: Record<string, string> = {};
    h.upload.mockImplementation(async (file: string) => {
      entries = await unzip(await readFile(file));
    });
    await buildOrganizationDataExport(payload);
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
    await buildOrganizationDataExport(payload);
    expect(h.upload).not.toHaveBeenCalled();
    h.request.mockResolvedValue({ occurredAt: new Date(0) });
    await buildOrganizationDataExport(payload);
    expect(h.usage).not.toHaveBeenCalled();
  });

  it('rejects a former owner before reading organization records', async () => {
    h.org.mockResolvedValue({ userId: 'successor' });
    await expect(buildOrganizationDataExport(payload)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.usage).not.toHaveBeenCalled();
  });

  it('rechecks ownership before upload', async () => {
    h.org.mockResolvedValueOnce({ userId: 'owner' }).mockResolvedValue({ userId: 'successor' });
    await expect(buildOrganizationDataExport(payload)).rejects.toMatchObject({ statusCode: 403 });
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'export.failed' }));
  });

  it('does not report completion on upload failure', async () => {
    h.upload.mockRejectedValue(new Error('upload failed'));
    await expect(buildOrganizationDataExport(payload)).rejects.toThrow('upload failed');
    expect(h.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'export.completed' }));
  });

  it('neutralizes CSV formulas and escapes quotes and newlines', () => {
    expect(exportCsvCell(' =1+1')).toBe('"\' =1+1"');
    expect(exportCsvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
});
