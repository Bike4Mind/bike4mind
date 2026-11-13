// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import { User, Organization, FabFile, userRepository } from '@bike4mind/database';
import { KnowledgeType, Permission } from '@bike4mind/common';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const transport = vi.hoisted(() => ({ send: vi.fn(), download: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (...handlers: unknown[]) => handlers.at(-1) }),
}));
vi.mock('@server/auth/assertOutboundActionAllowed', () => ({
  outboundActionGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('@server/utils/emailSendLimits', () => ({ reserveEmailSendBudget: async () => null }));
vi.mock('@bike4mind/services', () => ({ notebookCurationService: {} }));
vi.mock('@bike4mind/server-utils/utils/storage/index', () => ({
  getFilesStorage: () => ({ download: transport.download }),
}));
vi.mock('@server/utils/mailer/emailAttachments', () => ({ sendEmailWithAttachments: transport.send }));
import handler from '../send';

let mongo: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
});
beforeEach(() => {
  transport.send.mockReset().mockResolvedValue({ method: 'smtp', filesUploaded: 0 });
  transport.download.mockReset().mockResolvedValue(Buffer.from('fixture bytes'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function seed() {
  const owner = await User.create({ name: 'Owner', username: 'owner', password: null, hasUsablePassword: false });
  const member = await User.create({ name: 'Member', username: 'member', password: null, hasUsablePassword: false });
  // A legacy mixed-case address must still identify the actual member without collation.
  await User.collection.updateOne({ _id: member._id }, { $set: { email: 'MiXeD+tag@Member.Example' } });
  const organization = await Organization.create({
    name: 'Restricted',
    userId: String(owner._id),
    personal: false,
    users: [{ userId: String(member._id), permissions: [Permission.read] }],
    sharingPolicy: { allowPublicLinks: false, allowExternalSharing: false, allowedDomains: ['partner.example'] },
  });
  const file = await FabFile.create({
    userId: String(owner._id),
    organizationId: organization.id,
    fileName: 'fixture.txt',
    filePath: 'fixtures/share-policy.txt',
    type: KnowledgeType.FILE,
    mimeType: 'text/plain',
    moderationStatus: 'clean',
  });
  return { ownerId: String(owner._id), fileId: String(file._id) };
}
async function send(ownerId: string, fileId: string, email: string) {
  const { req, res } = createMocks({ method: 'POST', body: { type: 'files', fileIds: [fileId], recipients: [email] } });
  Object.assign(req, {
    user: { id: ownerId, name: 'Owner', groups: [] },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res;
}
function refuseCollation() {
  return vi.spyOn(mongoose.Query.prototype, 'collation').mockImplementation(() => {
    throw new Error('Collation is unavailable on DocumentDB 5');
  });
}
describe('email policy with the actual recipient repository', () => {
  it('resolves the exact mixed-case member through an escaped, ordinary query', async () => {
    const { ownerId, fileId } = await seed();
    const find = vi.spyOn(userRepository, 'findOne');
    const collation = refuseCollation();
    const response = await send(ownerId, fileId, 'mixed+tag@member.example');
    expect(response._getStatusCode()).toBe(200);
    expect(find).toHaveBeenCalledWith({ email: { $regex: '^mixed\\+tag@member\\.example$', $options: 'i' } });
    expect(collation).not.toHaveBeenCalled();
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
  it('does not turn email regex characters into a broader membership match', async () => {
    const { ownerId, fileId } = await seed();
    refuseCollation();
    const response = await send(ownerId, fileId, 'mixedtag@member.example');
    expect(response._getStatusCode()).toBe(403);
    expect(transport.download).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });
  it('permits a directly addressed approved domain without an account', async () => {
    const { ownerId, fileId } = await seed();
    refuseCollation();
    const response = await send(ownerId, fileId, 'new@partner.example');
    expect(response._getStatusCode()).toBe(200);
    expect(transport.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@partner.example' }),
      ownerId,
      'Owner'
    );
  });
});
