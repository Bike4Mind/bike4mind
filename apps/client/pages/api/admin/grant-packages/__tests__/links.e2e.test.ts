import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import { GrantPackage, PartnerSignupRule, RegistrationInvite } from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';

// Real adminApi permission gate; only the transport (baseApi) is stubbed so the middleware runs in-line.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let get: ((req: unknown, res: unknown) => unknown) | undefined;
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return get?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((get = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

import handler from '../[id]/links';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  await Promise.all([GrantPackage, PartnerSignupRule, RegistrationInvite].map(model => model.deleteMany({})));
});

const get = async (id: string, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  Object.assign(req, { user, ability: {} });
  const call = handler as unknown as (req: unknown, res: unknown) => Promise<unknown>;
  const error = await call(req, res).then(
    () => null,
    (thrown: unknown) => thrown
  );
  return { res, error };
};

const seedPackage = async (id?: string) =>
  String(
    (await GrantPackage.create({ ...(id ? { _id: id } : {}), name: 'Launch', credits: 100, createdBy: 'admin-1' }))._id
  );

describe('GET /api/admin/grant-packages/[id]/links (real Mongo)', () => {
  it.each(['lowercase', 'uppercase'] as const)(
    'returns canonical package links for a %s request ID, leaving other packages out',
    async casing => {
      const id = await seedPackage('abcdefabcdefabcdefabcdef');
      const other = await seedPackage();
      const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
      await PartnerSignupRule.create([
        { domain: 'old.com', grantPackageId: id, createdAt: at(1) },
        { domain: 'new.com', grantPackageId: id, enabled: false, organizationId: 'org-1', createdAt: at(2) },
        { domain: 'elsewhere.com', grantPackageId: other },
        { domain: 'unlinked.com', grantPackageId: null },
      ]);
      await RegistrationInvite.create([
        { status: 'open', userId: 'admin-1', code: 'PKG1', grantPackageId: id },
        { status: 'open', userId: 'admin-1', code: 'OTHER1', grantPackageId: other },
      ]);

      const { res, error } = await get(casing === 'uppercase' ? id.toUpperCase() : id);

      expect(error).toBeNull();
      expect(res._getStatusCode()).toBe(200);
      const body = res._getJSONData();
      expect(body.partnerRules.truncated).toBe(false);
      expect(body.partnerRules.data.map((rule: { domain: string }) => rule.domain)).toEqual(['new.com', 'old.com']);
      expect(body.partnerRules.data[0]).toMatchObject({ enabled: false, organizationId: 'org-1', grantPackageId: id });
      expect(body.partnerRules.data[0].id).toEqual(expect.any(String));
      expect(body.invites.data.map((invite: { code: string }) => invite.code)).toEqual(['PKG1']);
    }
  );

  it('flags partner rules past the 50 cap as truncated', async () => {
    const id = await seedPackage();
    await PartnerSignupRule.create(
      Array.from({ length: 51 }, (_unused, index) => ({ domain: `p${index}.com`, grantPackageId: id }))
    );

    const body = (await get(id)).res._getJSONData();

    expect(body.partnerRules.data).toHaveLength(50);
    expect(body.partnerRules.truncated).toBe(true);
  });

  it('refuses a delegated admin even with support:read and reads nothing', async () => {
    const id = await seedPackage();
    const { error } = await get(id, { id: 'delegate-1', isAdmin: false, adminPermissions: ['support:read'] });
    expect(error).toHaveProperty('statusCode', 403);
  });
});
