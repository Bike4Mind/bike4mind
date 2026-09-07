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
  // First argument the write received, so a test can assert on what actually reached the `$set`
  // rather than only on the status code. `payload` is the LAST write, and the mcp-servers POST
  // writes twice (create, then an update storing the discovered tools), so a test about what was
  // created has to read `created` instead.
  payload: undefined as unknown,
  created: undefined as unknown,
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
const writeSpy = (...args: unknown[]) => {
  handlers.wrote = true;
  handlers.payload = args[0];
  return found();
};
const createSpy = (...args: unknown[]) => {
  handlers.wrote = true;
  handlers.payload = args[0];
  handlers.created = args[0];
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
  mcpServerRepository: { findOne: () => Promise.resolve(null), create: createSpy, update: writeSpy },
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
  // `createLog`, not `create` -- the name the route actually calls. A mismatched mock name here
  // does not fail loudly: the handler throws `createLog is not a function`, `run` captures that
  // rejection in `outcome`, and an assertion that only checks "no 400 and something was written"
  // still passes because the mapping write happened before the audit call.
  rapidReplyAuditLogRepository: { createLog: () => found() },
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
  handlers.payload = undefined;
  handlers.created = undefined;
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
    user: { id: 'u1', isAdmin: c.admin, email: 'u1@example.test' },
    // The rapid-reply route writes an audit log that reads both of these. A missing `headers`
    // threw a TypeError mid-handler, which the accept-path assertions used to tolerate.
    headers: { 'user-agent': 'vitest' },
    ip: '127.0.0.1',
  } as any;

  const outcome = await Promise.resolve(handler!(req, res)).then(
    () => null,
    (e: unknown) => e
  );
  return { outcome, status, wrote: handlers.wrote, payload: handlers.payload, created: handlers.created };
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
      const { outcome, wrote } = await run(byRoute('admin/rapid-reply/mappings/[id]'), {
        responseStyle: 'casual',
      });
      expect(outcome).toBeNull();
      expect(wrote).toBe(true);
    });
  });

  // The first guard on this route used `z.looseObject`, which typed the 12 fields it named and
  // forwarded every other `AgentSchema` path to the `$set` uncast -- so the cases below were
  // still 500s. The schema is strict now, and these pin the paths a named-fields-only guard
  // misses: a top-level scalar it did not list, and a leaf inside a subtree.
  describe('agents/[id] rejects wrong types on paths beyond the ones a partial guard named', () => {
    it.each([
      ['a top-level Number path', { turnTimeoutSeconds: 'abc' }],
      ['a Boolean path from the shareable-document spread', { isGlobalRead: 'yes' }],
      ['a String leaf inside the personality subtree', { personality: { energyLevel: { a: 1 } } }],
      ['a Number leaf inside the tavernStats subtree', { tavernStats: { xp: 'abc' } }],
      ['a Date path', { lastSystemPromptGeneratedAt: 'not-a-date' }],
    ])('%s', async (_label, body) => {
      const { outcome, status, wrote } = await run(byRoute('agents/[id]'), body as Record<string, unknown>);

      const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
      const sent400 = status.mock.calls.some(call => call[0] === 400);
      expect(threw400 || sent400).toBe(true);
      expect(wrote).toBe(false);
    });

    // Asserting acceptance, not that the write is non-destructive: a partial subtree in a `$set`
    // replaces the whole subdocument, because mongoose does not dot-flatten it. That is this
    // route's pre-existing behavior -- it spread `req.body` into the `$set` before this guard
    // existed too -- and the app never hits it, since `AgentForm` round-trips the full subtree it
    // loaded. Do not read the shape below as a blessed partial-update idiom.
    it('still writes a well-typed value on a path outside the originally-named set', async () => {
      const { wrote } = await run(byRoute('agents/[id]'), {
        turnTimeoutSeconds: 12,
        personality: { energyLevel: 'high' },
        tavernStats: { xp: 40 },
      });
      expect(wrote).toBe(true);
    });

    // The cases above only prove the named paths are typed; a passthrough schema that happens to
    // name them would pass too. This is the one that separates strict from passthrough: a key no
    // schema mentions must be STRIPPED rather than forwarded, because a forwarded one reaches the
    // `$set` with no cast protection at all. Asserting on the payload, not the status, because a
    // forwarded key is not a validation error -- it is a silent write of an unvalidated value.
    it('strips a key the schema does not name instead of forwarding it to the $set', async () => {
      const { outcome, payload, wrote } = await run(byRoute('agents/[id]'), {
        name: 'renamed',
        notAnAgentField: { nested: 'value' },
      });

      expect(outcome).toBeNull();
      expect(wrote).toBe(true);
      expect(payload).toMatchObject({ name: 'renamed' });
      expect(payload).not.toHaveProperty('notAnAgentField');
    });
  });

  // `capabilities` is the one path a named-fields guard is not enough for on its own. The handler
  // converts a legacy object form to the stored array form, but that branch tests `!Array.isArray`,
  // so an array of objects walks past it into a `[String]` cast.
  describe('agents/[id] capabilities', () => {
    it.each([
      ['an array of objects (skips the legacy-object conversion)', { capabilities: [{ a: 1 }] }],
      ['an array of numbers', { capabilities: [1, 2] }],
      ['a bare string', { capabilities: 'not-an-array' }],
    ])('rejects %s', async (_label, body) => {
      const { outcome, status, wrote } = await run(byRoute('agents/[id]'), body as Record<string, unknown>);

      const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
      const sent400 = status.mock.calls.some(call => call[0] === 400);
      expect(threw400 || sent400).toBe(true);
      expect(wrote).toBe(false);
    });

    it('accepts the stored array-of-strings form', async () => {
      const { outcome, wrote } = await run(byRoute('agents/[id]'), {
        capabilities: ['{"triggerWords":["@help"],"responseStyle":"friendly","specialBehaviors":[]}'],
      });

      expect(outcome).toBeNull();
      expect(wrote).toBe(true);
    });

    it('accepts the legacy object form and converts it to the stored form', async () => {
      const { outcome, payload, wrote } = await run(byRoute('agents/[id]'), {
        capabilities: { triggerWords: ['@help'], responseStyle: 'formal', specialBehaviors: [] },
      });

      expect(outcome).toBeNull();
      expect(wrote).toBe(true);
      const written = (payload as { capabilities?: unknown[] })?.capabilities;
      expect(Array.isArray(written)).toBe(true);
      expect(typeof written?.[0]).toBe('string');
    });
  });

  // The scope discriminator is not in the accepted schema, so these are stripped rather than
  // rejected -- asserting on the payload, because a 200 that quietly wrote `userId: ''` is exactly
  // the failure being guarded. An empty string casts cleanly on a String path and leaves the agent
  // with no owner, which the executor's authz treats as a system agent.
  describe('agents/[id] does not let a body write the scope discriminator', () => {
    it.each(['userId', 'organizationId', 'isSystem'])('strips %s', async field => {
      const { outcome, payload, wrote } = await run(byRoute('agents/[id]'), {
        name: 'renamed',
        [field]: field === 'isSystem' ? true : '',
      });

      expect(outcome).toBeNull();
      expect(wrote).toBe(true);
      expect(payload).toMatchObject({ name: 'renamed' });
      expect(payload).not.toHaveProperty(field);
    });
  });

  // `_castUpdate` strips `enabled: undefined` from the `$set` before casting, so omitting it
  // against an existing server is a working 200 and must not become a 400. Only the create
  // branch needs it, and mongoose already enforces that.
  it('mcp-servers POST accepts a body that omits enabled', async () => {
    const { outcome, status } = await run(byRoute('mcp-servers'), {
      name: 'github',
      envVariables: [{ key: 'K', value: 'V' }],
    });
    const threw400 = outcome !== null && (outcome as { statusCode?: number }).statusCode === 400;
    const sent400 = status.mock.calls.some(call => call[0] === 400);
    expect(threw400 || sent400).toBe(false);
  });

  // `enabled` is `required: true` in the schema, so the create branch cannot pass `undefined`
  // through the way the update branch can. Defaulting rather than requiring it in the schema is
  // the choice that keeps the update branch's working call working; pinned because it is a
  // behaviour decision, not a type-level detail.
  it('mcp-servers POST defaults enabled to true when creating', async () => {
    const { outcome, created, wrote } = await run(byRoute('mcp-servers'), {
      name: 'github',
      envVariables: [{ key: 'K', value: 'V' }],
    });

    expect(outcome).toBeNull();
    expect(wrote).toBe(true);
    expect(created).toMatchObject({ name: 'github', enabled: true });
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
      const { outcome, status, wrote } = await run(c, valid[c.route]);
      // Not just "no 400": the handler must run to completion. Without this a mock whose method
      // name does not match the call site passes here, because the write it asserts on already
      // happened before the throw.
      expect(outcome, `${c.route} threw: ${(outcome as Error)?.message}`).toBeNull();
      expect(
        status.mock.calls.some(call => call[0] === 400),
        `${c.route} rejected a valid body`
      ).toBe(false);
      expect(wrote, `${c.route} did not write`).toBe(true);
    }
  });
});
