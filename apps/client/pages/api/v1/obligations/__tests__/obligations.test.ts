import { createMocks } from 'node-mocks-http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';

const { contracts, mocks } = vi.hoisted(() => ({
  contracts: [] as { operationId: string; auth: string; scopes?: readonly string[] }[],
  mocks: {
    handOffDocument: vi.fn(),
    createHandOffDeps: vi.fn(() => ({})),
    findByIdForUser: vi.fn(),
    applyUpdate: vi.fn(),
    listForUser: vi.fn(),
    addFileToWritableLake: vi.fn(),
    assertLakeMembershipWritable: vi.fn(),
    isFeatureEnabled: vi.fn(),
  },
}));

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: (contract: (typeof contracts)[number]) => {
    contracts.push(contract);
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const on = (method: string) => (fn: (req: unknown, res: unknown) => unknown) => ((handlers[method] = fn), chain);
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      { post: on('POST'), get: on('GET'), patch: on('PATCH') }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/dispatchByMethod', () => ({
  dispatchByMethod:
    (routes: Record<string, (req: unknown, res: unknown) => unknown>) => (req: { method: string }, res: unknown) =>
      routes[req.method](req, res),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
vi.mock('@server/obligations/handOffDocument', () => ({
  handOffDocument: mocks.handOffDocument,
  createHandOffDeps: mocks.createHandOffDeps,
}));
vi.mock('@bike4mind/server-utils/dataLakes/toAccessContext', () => ({
  toMemberAccessContext: async () => ({ userId: 'u1' }),
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ isFeatureEnabled: mocks.isFeatureEnabled }));
vi.mock('@server/dataLakes/lakeConfigAuditPrincipal', () => ({ lakeConfigAuditPrincipal: () => ({ kind: 'user' }) }));
vi.mock('@server/dataLakes/lakeMembershipWrite', () => ({
  addFileToWritableLake: mocks.addFileToWritableLake,
  assertLakeMembershipWritable: mocks.assertLakeMembershipWritable,
}));
vi.mock('@bike4mind/database', () => ({
  obligationDayToDate: (day: string) => new Date(`${day}T00:00:00.000Z`),
  obligationRepository: {
    findByIdForUser: mocks.findByIdForUser,
    applyUpdate: mocks.applyUpdate,
    listForUser: mocks.listForUser,
  },
}));

import { encodeCursor } from '@server/utils/cursorPagination';
import indexHandler from '../index';
import idHandler from '../[id]';

const ID = '6650c0ffee0000000000abcd';
const row = (over: Record<string, unknown> = {}) => ({
  _id: { toString: () => ID },
  userId: 'u1',
  fileId: 'file-1',
  status: 'pending',
  documentKind: 'invoice',
  amountValue: 120.5,
  currency: 'USD',
  payee: 'Example Utilities',
  dueDate: new Date('2026-12-15T00:00:00Z'),
  destinationLakeId: 'lake-1',
  destinationName: 'Bills',
  summary: 'Power bill',
  model: 'm',
  confirmedAt: null,
  createdAt: new Date('2026-11-24T00:00:00Z'),
  updatedAt: new Date('2026-11-24T00:00:00Z'),
  ...over,
});

type Handler = (req: unknown, res: unknown) => Promise<void>;
const call = async (handler: unknown, method: 'GET' | 'POST' | 'PATCH', extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: 'u1' }, logger: { info: vi.fn() }, ...extra });
  await (handler as Handler)(req, res);
  return res;
};
const patch = (validated: Record<string, unknown>, id = ID) =>
  call(idHandler, 'PATCH', { validated, validatedParams: { id } });

describe('/api/v1/obligations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFeatureEnabled.mockResolvedValue(true);
    mocks.findByIdForUser.mockResolvedValue(row());
    mocks.applyUpdate.mockImplementation(async (_id, _user, set) => row(set));
    mocks.addFileToWritableLake.mockImplementation(async ({ alsoInTransaction }) => ({
      extra: await alsoInTransaction({ id: 'lake-2', name: 'Taxes' }),
    }));
  });

  it('accepts an API key or a JWT, gated on the AI scopes', () => {
    expect(contracts.map(c => [c.operationId, c.auth, c.scopes])).toEqual([
      ['handOffObligation', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
      ['listObligations', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
      ['getObligation', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
      ['updateObligation', 'apiKeyOrJwt', ['ai:chat', 'ai:generate']],
    ]);
  });

  it('answers 201 for a new hand-off and 200 for a repeat of the same file', async () => {
    mocks.handOffDocument.mockResolvedValueOnce({ obligation: row(), created: true });
    const first = await call(indexHandler, 'POST', { validated: { file_id: 'file-1' } });
    expect(first._getStatusCode()).toBe(201);
    expect(first._getJSONData()).toMatchObject({ id: ID, status: 'pending', amount: { value: 120.5 } });
    expect(mocks.handOffDocument).toHaveBeenCalledWith('u1', { file_id: 'file-1' }, {});

    mocks.handOffDocument.mockResolvedValueOnce({ obligation: row(), created: false });
    const again = await call(indexHandler, 'POST', { validated: { file_id: 'file-1' } });
    expect(again._getStatusCode()).toBe(200);
  });

  it('refuses a key minted for a connected app on every route', async () => {
    const apiKeyInfo = { oauthExchangeClientId: 'client-1' };
    await expect(call(indexHandler, 'POST', { apiKeyInfo, validated: { file_id: 'f' } })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(call(indexHandler, 'GET', { apiKeyInfo, validatedQuery: { limit: 25 } })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(call(idHandler, 'GET', { apiKeyInfo, validatedParams: { id: ID } })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      call(idHandler, 'PATCH', { apiKeyInfo, validated: { status: 'confirmed' }, validatedParams: { id: ID } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.handOffDocument).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('pages the list with a cursor only when another page exists', async () => {
    mocks.listForUser.mockResolvedValueOnce([row(), row()]);
    const res = await call(indexHandler, 'GET', { validatedQuery: { limit: 1, status: 'confirmed' } });
    expect(mocks.listForUser).toHaveBeenCalledWith('u1', { cursor: undefined, limit: 2, status: 'confirmed' });
    expect(res._getJSONData().data).toHaveLength(1);
    expect(res._getJSONData().next_cursor).toEqual(expect.any(String));

    mocks.listForUser.mockResolvedValueOnce([row()]);
    const last = await call(indexHandler, 'GET', { validatedQuery: { limit: 1 } });
    expect(last._getJSONData().next_cursor).toBeNull();
  });

  it('resumes after the row a returned cursor names', async () => {
    mocks.listForUser.mockResolvedValueOnce([row(), row()]);
    const first = await call(indexHandler, 'GET', { validatedQuery: { limit: 1 } });
    const cursor = first._getJSONData().next_cursor;

    mocks.listForUser.mockResolvedValueOnce([]);
    await call(indexHandler, 'GET', { validatedQuery: { limit: 1, cursor } });
    expect(mocks.listForUser).toHaveBeenLastCalledWith('u1', { cursor: ID, limit: 2, status: undefined });
  });

  it('422s a malformed, foreign-scope or non-id cursor without reading', async () => {
    for (const cursor of ['garbage', encodeCursor('v1.other', ID), encodeCursor('v1.obligations', 'not-an-id')]) {
      await expect(call(indexHandler, 'GET', { validatedQuery: { limit: 1, cursor } })).rejects.toMatchObject({
        statusCode: 422,
      });
    }
    expect(mocks.listForUser).not.toHaveBeenCalled();
  });

  it('404s a foreign or malformed id on read and update', async () => {
    mocks.findByIdForUser.mockResolvedValue(null);
    await expect(call(idHandler, 'GET', { validatedParams: { id: 'not-an-id' } })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(patch({ payee: 'X' }, 'not-an-id')).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.findByIdForUser).toHaveBeenCalledWith('not-an-id', 'u1');
  });

  it('422s a body that sets no field, counting an explicit null as a change', async () => {
    await expect(patch({})).rejects.toMatchObject({ statusCode: 422 });
    await expect(patch({ payee: undefined })).rejects.toMatchObject({ statusCode: 422 });

    await patch({ payee: null });
    expect(mocks.applyUpdate).toHaveBeenCalledWith(ID, 'u1', { payee: null });
  });

  it('409s any change to a dismissed obligation', async () => {
    mocks.findByIdForUser.mockResolvedValue(row({ status: 'dismissed' }));
    await expect(patch({ status: 'confirmed' })).rejects.toMatchObject({ statusCode: 409 });
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('corrects fields on a pending obligation without filing it', async () => {
    const res = await patch({ amount: { value: 99, currency: 'EUR' }, due_date: null });
    expect(mocks.applyUpdate).toHaveBeenCalledWith(ID, 'u1', { amountValue: 99, currency: 'EUR', dueDate: null });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ amount: { value: 99, currency: 'EUR' }, due_date: null });
  });

  it('gates a new destination on a pending obligation and stores the resolved lake', async () => {
    mocks.assertLakeMembershipWritable.mockResolvedValue({ id: 'lake-9', name: 'Receipts' });
    await patch({ destination_lake_id: 'receipts' });
    expect(mocks.assertLakeMembershipWritable).toHaveBeenCalledWith('receipts', { userId: 'u1' }, expect.anything());
    expect(mocks.applyUpdate).toHaveBeenCalledWith(ID, 'u1', {
      destinationLakeId: 'lake-9',
      destinationName: 'Receipts',
    });
  });

  it('403s a destination the caller cannot manage and saves nothing', async () => {
    mocks.assertLakeMembershipWritable.mockRejectedValue(new ForbiddenError('no'));
    await expect(patch({ destination_lake_id: 'lake-x' })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('confirms by filing the scan into the stored destination inside the same transaction', async () => {
    const res = await patch({ status: 'confirmed' });
    expect(mocks.addFileToWritableLake).toHaveBeenCalledWith(
      expect.objectContaining({ lakeIdOrSlug: 'lake-1', ctx: { userId: 'u1' } })
    );
    const { resolveFileId } = mocks.addFileToWritableLake.mock.calls[0][0];
    expect(resolveFileId()).toBe('file-1');
    expect(mocks.applyUpdate).toHaveBeenCalledWith(
      ID,
      'u1',
      expect.objectContaining({ status: 'confirmed', confirmedAt: expect.any(Date), destinationLakeId: 'lake-2' })
    );
    expect(res._getJSONData()).toMatchObject({ status: 'confirmed', confirmed_at: expect.any(String) });
  });

  it('leaves the obligation unconfirmed when filing fails', async () => {
    mocks.addFileToWritableLake.mockRejectedValue(new NotFoundError('Data lake not found'));
    await expect(patch({ status: 'confirmed' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('confirms with no destination without touching any lake', async () => {
    mocks.findByIdForUser.mockResolvedValue(row({ destinationLakeId: null, destinationName: null }));
    await patch({ status: 'confirmed' });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).toHaveBeenCalledWith(ID, 'u1', expect.objectContaining({ status: 'confirmed' }));
  });

  it('404s a lake destination while data lakes are off, before any write', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    await expect(patch({ status: 'confirmed' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('404s a new lake destination on a pending obligation while data lakes are off', async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    await expect(patch({ destination_lake_id: 'lake-2' })).rejects.toMatchObject({ statusCode: 404 });
    expect(mocks.applyUpdate).not.toHaveBeenCalled();
  });

  it('lets an AI-only key clear the destination, since that files nothing', async () => {
    await call(idHandler, 'PATCH', {
      apiKeyInfo: { scopes: ['ai:chat'] },
      validated: { destination_lake_id: null },
      validatedParams: { id: ID },
    });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).toHaveBeenLastCalledWith(ID, 'u1', { destinationLakeId: null, destinationName: null });
  });

  it('keeps a confirmed obligation editable and files a changed destination into the new lake only', async () => {
    const confirmedAt = new Date('2026-11-20T00:00:00Z');
    mocks.findByIdForUser.mockResolvedValue(row({ status: 'confirmed', confirmedAt }));

    await patch({ payee: 'Example Power' });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).toHaveBeenLastCalledWith(ID, 'u1', { payee: 'Example Power' });

    await patch({ destination_lake_id: 'lake-2' });
    expect(mocks.addFileToWritableLake).toHaveBeenCalledWith(expect.objectContaining({ lakeIdOrSlug: 'lake-2' }));
    const set = mocks.applyUpdate.mock.calls.at(-1)?.[2];
    expect(set).not.toHaveProperty('confirmedAt');
  });

  it('needs datalake:write on an API key to choose or file into a lake, and hides lakes without read', async () => {
    const aiOnly = { apiKeyInfo: { scopes: ['ai:chat'] } };
    await expect(
      call(idHandler, 'PATCH', { ...aiOnly, validated: { status: 'confirmed' }, validatedParams: { id: ID } })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      call(idHandler, 'PATCH', { ...aiOnly, validated: { destination_lake_id: 'lake-2' }, validatedParams: { id: ID } })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.addFileToWritableLake).not.toHaveBeenCalled();
    expect(mocks.applyUpdate).not.toHaveBeenCalled();

    const read = await call(idHandler, 'GET', { ...aiOnly, validatedParams: { id: ID } });
    expect(read._getJSONData().destination).toBeNull();

    const writer = { apiKeyInfo: { scopes: ['ai:chat', 'datalake:write'] } };
    const res = await call(idHandler, 'PATCH', {
      ...writer,
      validated: { status: 'confirmed' },
      validatedParams: { id: ID },
    });
    expect(mocks.addFileToWritableLake).toHaveBeenCalled();
    expect(res._getJSONData().destination).toMatchObject({ lake_id: 'lake-2' });
  });

  it('suggests a destination at hand-off only to a caller that can file into it', async () => {
    mocks.handOffDocument.mockResolvedValue({ obligation: row(), created: true });
    const offered = async (extra: Record<string, unknown>) => {
      const res = await call(indexHandler, 'POST', { ...extra, validated: { file_id: 'file-1' } });
      return { offerLakes: mocks.createHandOffDeps.mock.calls.at(-1)?.[2]?.offerLakes, body: res._getJSONData() };
    };
    expect((await offered({})).offerLakes).toBe(true);
    expect((await offered({ apiKeyInfo: { scopes: ['ai:chat', 'datalake:write'] } })).offerLakes).toBe(true);
    const reader = await offered({ apiKeyInfo: { scopes: ['ai:chat', 'datalake:read'] } });
    expect(reader.offerLakes).toBe(false);
    expect(reader.body.destination).toMatchObject({ lake_id: 'lake-1' });
    const aiOnly = await offered({ apiKeyInfo: { scopes: ['ai:chat'] } });
    expect(aiOnly.offerLakes).toBe(false);
    expect(aiOnly.body.destination).toBeNull();
  });

  it('answers 409 and rolls the filing back when a dismiss lands mid-confirm', async () => {
    mocks.applyUpdate.mockResolvedValue(null);
    await expect(patch({ status: 'confirmed' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(patch({ payee: 'Example Power' })).rejects.toMatchObject({ statusCode: 409 });
  });
});
