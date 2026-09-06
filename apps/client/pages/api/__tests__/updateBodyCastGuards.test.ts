import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * One reject-path test per route that puts caller-supplied body values into a Mongoose update
 * payload. Update payloads cast before validators run, so a value of the wrong JSON type on a
 * casting path throws a CastError whose `path` is not `_id` - a 500 at `error` level, where the
 * blanket CastError mapping used to answer 404.
 *
 * The shapes below were measured against the pinned mongoose 8.24.1 rather than assumed:
 *   Boolean path   -> 2, {} and [] throw; true/'true'/1/'1' are accepted and coerced
 *   Number path    -> 'abc' and {} throw
 *   String path    -> an array or object throws; a number or boolean is coerced
 *   [String] path  -> an object element throws (as `path: 'field.0'`)
 * A `Map<String>` path raises a TypeError rather than a CastError, so it answers 500 both
 * before and after the narrowing and is deliberately not asserted as a cast case here.
 */

const handlers = vi.hoisted(() => ({
  put: null as null | ((req: any, res: any) => unknown),
  post: null as null | ((req: any, res: any) => unknown),
  wrote: false,
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    delete: () => chain,
    patch: () => chain,
    put: (fn: any) => {
      handlers.put = fn;
      return chain;
    },
    post: (fn: any) => {
      handlers.post = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const found = (extra: Record<string, unknown> = {}) => Promise.resolve({ id: 'x', ...extra });
const writeSpy = () => {
  handlers.wrote = true;
  return found();
};

vi.mock('@bike4mind/database', () => ({
  emailTemplateRepository: {
    findById: () => found({ slug: 'existing-slug' }),
    findBySlug: () => Promise.resolve(null),
    update: writeSpy,
  },
  emailJobRepository: { findById: () => found({ overallStatus: 'draft' }), update: writeSpy },
  // `userId` matches the request user below, so the ownership check passes and the body
  // validation is what decides the outcome.
  agentRepository: { findById: () => found({ userId: 'u1', triggerWords: [] }), update: writeSpy },
  mcpServerRepository: { findOne: () => Promise.resolve(null), create: writeSpy, update: writeSpy },
  fabFileRepository: { findById: () => Promise.resolve(null) },
  userRepository: { findById: () => found() },
  creditTransactionRepository: { create: () => found() },
  adminSettingsRepository: { findAll: () => Promise.resolve([]) },
  User: {},
}));

vi.mock('@bike4mind/services', () => ({ creditService: {} }));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({}) }));

vi.mock('@bike4mind/database/ai', () => ({
  rapidReplyMappingRepository: {
    findById: () => found({ mainModelId: 'm1' }),
    findByMainModel: () => Promise.resolve(null),
    updateMapping: writeSpy,
  },
  rapidReplyAuditLogRepository: { create: () => found() },
  McpServer: {
    findById: () => found({ userId: 'u1' }),
    findOneAndUpdate: writeSpy,
    findOneAndDelete: () => found(),
    findOne: () => found({ userId: 'u1' }),
  },
}));

vi.mock('@bike4mind/database/content', () => ({
  ResearchLinkCategory: { findByIdAndUpdate: writeSpy, findByIdAndDelete: () => found() },
}));

vi.mock('@server/security/tokenEncryption', () => ({
  encryptEnvVariables: (v: unknown) => v,
  decryptEnvVariables: (v: unknown) => v,
}));

vi.mock('@server/utils/invokeMcpHandler', () => ({ invokeMcpHandler: () => Promise.resolve([]) }));
vi.mock('@bike4mind/mcp', () => ({ MCPClient: class {} }));

type Case = {
  route: string;
  load: () => Promise<unknown>;
  admin: boolean;
  body: Record<string, unknown>;
  label: string;
  /** Defaults to PUT; the mcp-servers collection route takes its body on POST. */
  method?: 'PUT' | 'POST';
};

const cases: Case[] = [
  {
    route: 'mcp-servers/[id]',
    load: () => import('@pages/api/mcp-servers/[id]/index'),
    admin: false,
    label: 'a Boolean path given 2',
    body: { envVariables: [], enabled: 2 },
  },
  {
    route: 'business-links/category/[id]',
    load: () => import('@pages/api/business-links/category/[id]'),
    admin: true,
    label: 'a String path given an array',
    body: { name: ['a', 'b'] },
  },
  {
    route: 'admin/email/templates/[id]',
    load: () => import('@pages/api/admin/email/templates/[id]'),
    admin: true,
    label: 'a [String] path given an object element',
    body: { variables: [{ nested: true }] },
  },
  {
    route: 'admin/email/jobs/[id]',
    load: () => import('@pages/api/admin/email/jobs/[id]/index'),
    admin: true,
    label: 'a nested Boolean path given []',
    body: { recipientFilter: { all: [] } },
  },
  {
    route: 'admin/rapid-reply/mappings/[id]',
    load: () => import('@pages/api/admin/rapid-reply/mappings/[id]'),
    admin: true,
    label: 'a Number path given a non-numeric string',
    body: { priority: 'abc' },
  },
  {
    // Not admin-gated, ownership check only. The range checks in this handler read
    // `temperature < 0 || temperature > 2`, and both are false for a string, so 'abc'
    // reached the Number-typed path untouched before the guard.
    route: 'agents/[id]',
    load: () => import('@pages/api/agents/[id]/index'),
    admin: false,
    label: 'a Number path given a string the range checks let through',
    body: { temperature: 'abc' },
  },
  {
    // Not admin-gated. The cast here happens on the `findOne` FILTER at the handler's first
    // statement, before any write - filters cast just like update payloads do.
    route: 'mcp-servers',
    load: () => import('@pages/api/mcp-servers/index'),
    admin: false,
    method: 'POST',
    label: 'a String path given an object on the lookup filter',
    // Every other field is valid, so the rejection is attributable to `name` alone.
    body: { name: { a: 1 }, envVariables: [], enabled: true },
  },
];

/** Look a case up by route rather than by index, so inserting a case cannot silently retarget. */
const byRoute = (route: string): Case => {
  const found = cases.find(c => c.route === route);
  if (!found) {
    throw new Error(`no case for route ${route}`);
  }
  return found;
};

const run = async (c: Case, body: Record<string, unknown>) => {
  const method = c.method ?? 'PUT';
  handlers.put = null;
  handlers.post = null;
  handlers.wrote = false;
  vi.resetModules();
  await c.load();
  const handler = method === 'POST' ? handlers.post : handlers.put;
  expect(handler).toBeTypeOf('function');

  const status = vi.fn(() => ({ json: vi.fn(), end: vi.fn() }));
  const res = { status, json: vi.fn() } as any;
  const req = {
    method,
    url: `/api/${c.route}`,
    query: { id: '507f1f77bcf86cd799439011' },
    body,
    user: { id: 'u1', isAdmin: c.admin },
  } as any;

  const outcome = await Promise.resolve(handler!(req, res)).then(
    () => null,
    (e: unknown) => e
  );
  return { outcome, status, wrote: handlers.wrote };
};

describe('update-payload cast guards - a wrong-typed body value is a client error, not a 500', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  for (const c of cases) {
    it(`${c.route} rejects ${c.label} before anything is written`, async () => {
      const { outcome, status, wrote } = await run(c, c.body);

      // Routes in this set answer either by throwing a 400 HTTPError or by res.status(400).
      const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
      const sent400 = status.mock.calls.some(call => call[0] === 400);
      expect(threw400 || sent400).toBe(true);
      // Nothing reached the database, so no CastError could be raised.
      expect(wrote).toBe(false);
    });
  }

  it('mcp-servers/[id] is not admin-gated, so this is reachable by any authenticated caller', async () => {
    const { outcome, status } = await run(cases[0], { envVariables: [], enabled: 2 });
    const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
    const sent400 = status.mock.calls.some(call => call[0] === 400);
    expect(threw400 || sent400).toBe(true);
    // The point of the case: no isAdmin was set on the request and it still got this far.
    expect(cases[0].admin).toBe(false);
  });

  // A different failure mode from the casts above, and the reason these two fields are
  // validated against their enum rather than typed as plain strings: the schemas declare an
  // `enum`, but both write paths reach `findOneAndUpdate` without `runValidators`, and mongoose
  // skips validators on update queries by default. So an unknown value was never a 500 - it was
  // a 200 that wrote a value nothing downstream recognises.
  describe('enum membership on update paths, which mongoose does not enforce', () => {
    it.each([
      ['admin/email/templates/[id]', { category: 'TOTALLY_BOGUS' }],
      ['admin/rapid-reply/mappings/[id]', { responseStyle: 'TOTALLY_BOGUS' }],
    ])('%s rejects an out-of-enum value instead of writing it', async (route, body) => {
      const { outcome, status, wrote } = await run(byRoute(route as string), body as Record<string, unknown>);

      const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
      const sent400 = status.mock.calls.some(call => call[0] === 400);
      expect(threw400 || sent400).toBe(true);
      expect(wrote).toBe(false);
    });

    it('still accepts a value that is in the enum', async () => {
      const { wrote } = await run(byRoute('admin/rapid-reply/mappings/[id]'), { responseStyle: 'casual' });
      expect(wrote).toBe(true);
    });
  });

  it('still accepts a well-typed body on every route', async () => {
    const valid: Record<string, Record<string, unknown>> = {
      'mcp-servers/[id]': { envVariables: [{ key: 'K', value: 'V' }], enabled: true },
      'business-links/category/[id]': { name: 'renamed' },
      'admin/email/templates/[id]': { variables: ['a', 'b'], isActive: true },
      'admin/email/jobs/[id]': { recipientFilter: { all: true }, isTestMode: false },
      'admin/rapid-reply/mappings/[id]': { priority: 3, enabled: true },
      'agents/[id]': { name: 'renamed', temperature: 1.5 },
      'mcp-servers': { name: 'github', envVariables: [{ key: 'K', value: 'V' }], enabled: true },
    };

    for (const c of cases) {
      const { status, wrote } = await run(c, valid[c.route]);
      expect(
        status.mock.calls.some(call => call[0] === 400),
        `${c.route} rejected a valid body`
      ).toBe(false);
      expect(wrote, `${c.route} did not write`).toBe(true);
    }
  });
});
